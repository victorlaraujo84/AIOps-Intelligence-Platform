import asyncio
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StringConstraints

from .postgres_auth import (
    AUTH_HEADERS, AuthRoute, PostgresAuth, get_auth, get_current_session, get_token, hash_password, unauthorized,
)


router = APIRouter(prefix="/api/v1/tenant-users", tags=["authentication"], route_class=AuthRoute)

Auth = Annotated[PostgresAuth, Depends(get_auth)]
Token = Annotated[str, Depends(get_token)]
Tenant = Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")]


class NewUser(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, max_length=254, pattern=r"^[^\s@]+@[^\s@]+$")]
    full_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
    role: Literal["tenant_admin", "tenant_operator", "tenant_viewer"] = "tenant_viewer"
    password: Annotated[SecretStr, Field(min_length=8, max_length=1024)]


class UserStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")

    is_active: Annotated[bool, Field(strict=True)]


async def require_admin(identity: Annotated[asyncpg.Record, Depends(get_current_session)], tenant: Tenant):
    if identity["role"] not in {"super_admin", "tenant_admin"}:
        raise HTTPException(403, "Acesso restrito a administradores.", headers=AUTH_HEADERS)
    if identity["active_tenant_id"] != tenant:
        raise HTTPException(409, "Selecione ou confirme o tenant ativo.", headers=AUTH_HEADERS)


async def admin_query(auth: PostgresAuth, sql: str, token: str, tenant: UUID, *args):
    errors = {
        "42501": (403, "Acesso restrito a administradores."),
        "22023": (422, "Não é possível aplicar esta alteração de usuário."),
        "P1001": (409, "Selecione ou confirme o tenant ativo."),
        "P1002": (409, "Este e-mail está indisponível."),
        "P1003": (404, "Usuário não encontrado neste tenant."),
    }
    try:
        return await auth.pool.fetch(sql, auth.token_hash(token), tenant, *args, timeout=5)
    except asyncpg.PostgresError as error:
        if error.sqlstate == "28000":
            raise unauthorized() from None
        status, message = errors.get(error.sqlstate, (503, "Administração de usuários indisponível."))
    except (asyncpg.InterfaceError, OSError, TimeoutError):
        status, message = 503, "Administração de usuários indisponível."
    raise HTTPException(status, message, headers=AUTH_HEADERS) from None


@router.get("", dependencies=[Depends(require_admin)])
async def list_users(
    response: Response, auth: Auth, token: Token, tenant: Tenant,
    limit: Annotated[int, Query(ge=1, le=100)] = 50, after: UUID | None = None,
):
    rows = await admin_query(
        auth, "SELECT * FROM aiops_auth.list_tenant_users($1, $2, $3, $4)", token, tenant, after, limit + 1,
    )
    response.headers.update(AUTH_HEADERS)
    return {"items": [dict(row) for row in rows[:limit]], "next_after": rows[limit - 1]["id"] if len(rows) > limit else None}


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
async def create_user(body: NewUser, response: Response, auth: Auth, token: Token, tenant: Tenant):
    try:
        async with auth.password_checks:
            hashed = await asyncio.to_thread(hash_password, body.password.get_secret_value())
    except UnicodeError:
        raise HTTPException(422, "Senha inválida.", headers=AUTH_HEADERS) from None
    rows = await admin_query(
        auth, "SELECT aiops_auth.create_tenant_user($1, $2, $3, $4, $5, $6) AS id",
        token, tenant, body.email, body.full_name, body.role, hashed,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(rows[0])


@router.patch("/{user_id}/status", dependencies=[Depends(require_admin)])
async def set_status(user_id: UUID, body: UserStatus, response: Response, auth: Auth, token: Token, tenant: Tenant):
    rows = await admin_query(
        auth, "SELECT aiops_auth.set_tenant_user_active($1, $2, $3, $4) AS is_active",
        token, tenant, user_id, body.is_active,
    )
    response.headers.update(AUTH_HEADERS)
    return {"id": user_id, "is_active": rows[0]["is_active"]}
