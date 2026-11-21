from contextlib import asynccontextmanager
import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, StringConstraints

from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import COLUMNS, inventory_role_pool


router = APIRouter(prefix="/api/v1/inventory/sites", tags=["inventory"])
SITE_FIELDS = COLUMNS["sites"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Code = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
State = Annotated[str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Za-z]{2}$")]
Criticality = Literal["critica", "alta", "media", "baixa"]

CHECK_WRITER_ROLE = """
SELECT pg_has_role(current_user, 'aiops_site_writer', 'SET')
  AND NOT (
    pg_has_role(current_user, 'aiops_site_writer', 'USAGE')
    OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
    OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
    OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_schema_privilege(current_user, 'aiops_auth', 'USAGE')
    OR has_any_column_privilege(current_user, 'public.users', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sites', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.sites', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.audit_logs', 'SELECT, INSERT, UPDATE, REFERENCES')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


class CreateSite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Code
    name: Name
    municipality: Name | None = None
    uf: State | None = None
    criticality: Criticality = "media"


class UpdateSite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Name | None = None
    municipality: Name | None = None
    uf: State | None = None
    criticality: Criticality | None = None


@asynccontextmanager
async def postgres_site_write_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_SITE_WRITE_DSN", "")
    app.state.site_write_pool = None
    if not dsn:
        yield
        return
    if app.state.postgres_auth is None:
        raise RuntimeError("A gravação de sites exige a autenticação PostgreSQL configurada.")

    async with inventory_role_pool(
        dsn, CHECK_WRITER_ROLE, "Configure uma conta que possa assumir apenas aiops_site_writer sem herdar acesso.",
    ) as pool:
        app.state.site_write_pool = pool
        try:
            yield
        finally:
            app.state.site_write_pool = None


def get_site_write_pool(request: Request) -> asyncpg.Pool:
    pool = request.app.state.site_write_pool
    if pool is None:
        raise HTTPException(503, "Gravação PostgreSQL de sites desabilitada.", headers=AUTH_HEADERS)
    return pool


@asynccontextmanager
async def site_transaction(pool: asyncpg.Pool, identity: asyncpg.Record):
    if identity["role"] not in {"super_admin", "tenant_admin", "tenant_operator"}:
        raise HTTPException(403, "Permissão insuficiente para alterar sites.", headers=AUTH_HEADERS)
    tenant = identity["active_tenant_id"]
    if tenant is None:
        raise HTTPException(409, "Selecione um tenant ativo.", headers=AUTH_HEADERS)

    try:
        async with pool.acquire(timeout=5) as connection:
            async with connection.transaction():
                await connection.execute("SET LOCAL ROLE aiops_site_writer")
                await connection.execute(
                    "SELECT pg_catalog.set_config('app.current_tenant_id', $1, true),"
                    " pg_catalog.set_config('app.current_actor_id', $2, true)",
                    str(tenant), str(identity["id"]),
                )
                active = await connection.fetchval("SELECT status = 'active' FROM public.tenants WHERE id = $1", tenant)
                if not active:
                    raise HTTPException(409, "Tenant ativo indisponível.", headers=AUTH_HEADERS)
                yield connection, tenant
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError) as error:
        if isinstance(error, asyncpg.UniqueViolationError) and error.constraint_name == "sites_tenant_id_code_key":
            raise HTTPException(409, "Já existe um site com este código neste tenant.", headers=AUTH_HEADERS) from None
        raise HTTPException(503, "Gravação de sites temporariamente indisponível.", headers=AUTH_HEADERS) from None


async def audit_site(connection: asyncpg.Connection, tenant: UUID, identity: asyncpg.Record, action: str, site_id: UUID):
    await connection.execute(
        """
        INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
        VALUES ($1, $2, $3, $4, 'site', $5)
        """,
        tenant, identity["id"], identity["role"], action, str(site_id),
    )


@router.post("", status_code=201)
async def create_site(
    body: CreateSite,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    async with site_transaction(pool, identity) as (connection, tenant):
        site = await connection.fetchrow(
            f"""
            INSERT INTO public.sites (tenant_id, code, name, municipality, uf, criticality)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING {SITE_FIELDS}
            """,
            tenant, body.code.upper(), body.name, body.municipality, body.uf, body.criticality,
        )
        await audit_site(connection, tenant, identity, "SITE_CREATED", site["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(site)


@router.patch("/{site_id}")
async def update_site(
    site_id: UUID,
    body: UpdateSite,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    changes = body.model_dump(exclude_unset=True)
    if not changes or any(field in changes and changes[field] is None for field in ("name", "criticality")):
        raise HTTPException(422, "Informe campos válidos para atualizar o site.", headers=AUTH_HEADERS)

    # Os únicos nomes possíveis vêm dos campos declarados em UpdateSite.
    assignments = ", ".join(f"{field} = ${index}" for index, field in enumerate(changes, 3))
    async with site_transaction(pool, identity) as (connection, tenant):
        site = await connection.fetchrow(
            f"""
            UPDATE public.sites SET {assignments}, updated_at_utc = now()
            WHERE id = $1 AND tenant_id = $2 RETURNING {SITE_FIELDS}
            """,
            site_id, tenant, *changes.values(),
        )
        if site is None:
            raise HTTPException(404, "Site não encontrado.", headers=AUTH_HEADERS)
        await audit_site(connection, tenant, identity, "SITE_UPDATED", site_id)
    response.headers.update(AUTH_HEADERS)
    return dict(site)
