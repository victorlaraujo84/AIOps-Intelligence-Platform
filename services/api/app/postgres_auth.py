import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import os
import re
import secrets
from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, SecretStr


bearer = HTTPBearer(auto_error=False)
PASSWORD_HASH = re.compile(r"scrypt:([0-9a-f]{32}):([0-9a-f]{128})")
SESSION_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
DUMMY_HASH = f"scrypt:{'0' * 32}:{'0' * 128}"
AUTH_HEADERS = {"Cache-Control": "no-store"}
CHECK_DATABASE_ROLE = """
SELECT pg_has_role(current_user, 'aiops_authenticator', 'USAGE')
  AND NOT (
    r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR pg_has_role(current_user, 'aiops_tenant_reader', 'MEMBER')
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_any_column_privilege(current_user, 'public.users', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.users', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege(current_user, 'public.sessions', 'DELETE, TRUNCATE, TRIGGER')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


class AuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "Dados de autenticação inválidos.", headers=AUTH_HEADERS) from None

        return handle


router = APIRouter(prefix="/api/v1/auth", tags=["authentication"], route_class=AuthRoute)


class LoginRequest(BaseModel):
    email: Annotated[str, Field(min_length=1, max_length=254)]
    password: Annotated[SecretStr, Field(min_length=1, max_length=1024)]


class SelectTenantRequest(BaseModel):
    tenant_id: UUID


def verify_scrypt(password: str, stored_hash: str) -> bool:
    match = PASSWORD_HASH.fullmatch(stored_hash)
    if match is None:
        return False
    salt, expected = match.groups()
    # O Web Node usa os caracteres hexadecimais do salt como bytes UTF-8.
    try:
        password_bytes = password.encode("utf-8")
    except UnicodeError:
        return False
    derived = hashlib.scrypt(password_bytes, salt=salt.encode("ascii"), n=16384, r=8, p=1, dklen=64)
    return hmac.compare_digest(derived, bytes.fromhex(expected))


class PostgresAuth:
    def __init__(self, pool: asyncpg.Pool, session_secret: str):
        self.pool = pool
        self.secret = session_secret.encode("utf-8")
        self.password_checks = asyncio.Semaphore(4)

    def token_hash(self, token: str) -> str:
        return hmac.new(self.secret, token.encode("ascii"), hashlib.sha256).hexdigest()

    async def query(self, sql: str, *args):
        try:
            return await self.pool.fetchrow(sql, *args, timeout=5)
        except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError):
            raise HTTPException(503, "Autenticação temporariamente indisponível.", headers=AUTH_HEADERS) from None

    async def login(self, email: str, password: str) -> str | None:
        row = await self.query("SELECT * FROM aiops_auth.find_login($1)", email)
        hash_to_check = row["password_hash"] if row else DUMMY_HASH
        if not PASSWORD_HASH.fullmatch(hash_to_check):
            hash_to_check = DUMMY_HASH
        async with self.password_checks:
            valid = await asyncio.to_thread(verify_scrypt, password, hash_to_check)
        if row is None or not valid or hash_to_check == DUMMY_HASH:
            return None

        token = secrets.token_urlsafe(32)
        result = await self.query(
            "SELECT aiops_auth.start_session($1, $2, $3) AS created",
            row["id"], hash_to_check, self.token_hash(token),
        )
        return token if result["created"] else None


@asynccontextmanager
async def postgres_auth_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_AUTH_DSN", "")
    secret = os.environ.get("AIOPS_POSTGRES_AUTH_SESSION_SECRET", "")
    app.state.postgres_auth = None
    if not dsn and not secret:
        yield
        return
    if not dsn or len(secret.strip().encode("utf-8")) < 32 or secret.strip().startswith("CHANGE_ME"):
        raise RuntimeError("A autenticação PostgreSQL exige DSN e segredo de sessão com pelo menos 32 bytes.")

    pool = None
    try:
        try:
            pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4, timeout=5, command_timeout=5)
            allowed = await pool.fetchval(CHECK_DATABASE_ROLE, timeout=5)
        except Exception:
            raise RuntimeError("Falha ao iniciar a autenticação PostgreSQL. Confira o DSN e a migração 007.") from None
        if not allowed:
            raise RuntimeError("Configure uma conta de serviço restrita ao papel aiops_authenticator.")
        app.state.postgres_auth = PostgresAuth(pool, secret)
        yield
    finally:
        app.state.postgres_auth = None
        if pool is not None:
            await pool.close()


def get_auth(request: Request) -> PostgresAuth:
    auth = request.app.state.postgres_auth
    if auth is None:
        raise HTTPException(503, "Autenticação PostgreSQL desabilitada.", headers=AUTH_HEADERS)
    return auth


def unauthorized() -> HTTPException:
    return HTTPException(401, "Credenciais inválidas.", headers={**AUTH_HEADERS, "WWW-Authenticate": "Bearer"})


def get_token(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> str:
    if credentials is None or not SESSION_TOKEN.fullmatch(credentials.credentials):
        raise unauthorized()
    return credentials.credentials


async def get_current_session(
    auth: Annotated[PostgresAuth, Depends(get_auth)],
    token: Annotated[str, Depends(get_token)],
) -> asyncpg.Record:
    row = await auth.query("SELECT * FROM aiops_auth.find_session($1)", auth.token_hash(token))
    if row is None:
        raise unauthorized()
    return row


@router.post("/login")
async def login(body: LoginRequest, response: Response, auth: Annotated[PostgresAuth, Depends(get_auth)]):
    token = await auth.login(body.email.strip().lower(), body.password.get_secret_value())
    if token is None:
        raise unauthorized()
    response.headers.update(AUTH_HEADERS)
    return {"access_token": token, "token_type": "bearer"}


@router.get("/me")
async def me(response: Response, identity: Annotated[asyncpg.Record, Depends(get_current_session)]):
    response.headers.update(AUTH_HEADERS)
    return dict(identity)


@router.post("/switch-tenant")
async def switch_tenant(
    body: SelectTenantRequest,
    response: Response,
    auth: Annotated[PostgresAuth, Depends(get_auth)],
    token: Annotated[str, Depends(get_token)],
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
):
    if identity["role"] != "super_admin":
        raise HTTPException(403, "Somente administradores globais podem selecionar outros tenants.", headers=AUTH_HEADERS)
    result = await auth.query(
        "SELECT aiops_auth.select_tenant($1, $2) AS selected", auth.token_hash(token), body.tenant_id,
    )
    if not result["selected"]:
        raise HTTPException(404, "Tenant ativo indisponível.", headers=AUTH_HEADERS)
    response.headers.update(AUTH_HEADERS)
    return {"active_tenant_id": body.tenant_id}


@router.post("/logout", status_code=204)
async def logout(auth: Annotated[PostgresAuth, Depends(get_auth)], token: Annotated[str, Depends(get_token)]):
    await auth.query("SELECT aiops_auth.end_session($1)", auth.token_hash(token))
    return Response(status_code=204, headers=AUTH_HEADERS)
