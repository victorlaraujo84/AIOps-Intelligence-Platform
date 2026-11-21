from contextlib import asynccontextmanager
import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response

from .postgres_auth import AUTH_HEADERS, get_current_session


Resource = Literal["sites", "assets", "services"]
router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])
COLUMNS = {
    "sites": "id, tenant_id, code, name, municipality, uf, latitude, longitude, coord_verified, criticality",
    "assets": "id, tenant_id, site_id, name, hostname, domain, georeference_mode, asset_type_code, operational_state",
    "services": "id, tenant_id, code, name, domain, criticality, owner_team, operational_state",
}

CHECK_READER_ROLE = """
SELECT pg_has_role(current_user, 'aiops_tenant_reader', 'SET')
  AND NOT (
    pg_has_role(current_user, 'aiops_tenant_reader', 'USAGE')
    OR pg_has_role(current_user, 'aiops_authenticator', 'MEMBER')
    OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_schema_privilege(current_user, 'aiops_auth', 'USAGE')
    OR has_any_column_privilege(current_user, 'public.users', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sessions', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.sites', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.assets', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.services', 'SELECT')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


@asynccontextmanager
async def postgres_inventory_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_INVENTORY_DSN", "")
    app.state.inventory_pool = None
    if not dsn:
        yield
        return
    if app.state.postgres_auth is None:
        raise RuntimeError("O inventário exige a autenticação PostgreSQL configurada.")

    pool = None
    try:
        try:
            pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4, timeout=5, command_timeout=5)
            allowed = await pool.fetchval(CHECK_READER_ROLE, timeout=5)
        except Exception:
            raise RuntimeError("Falha ao iniciar o inventário PostgreSQL. Confira o DSN e as migrações.") from None
        if not allowed:
            raise RuntimeError("Configure uma conta que possa assumir apenas aiops_tenant_reader sem herdar acesso.")
        app.state.inventory_pool = pool
        yield
    finally:
        app.state.inventory_pool = None
        if pool is not None:
            await pool.close()


def get_inventory_pool(request: Request) -> asyncpg.Pool:
    pool = request.app.state.inventory_pool
    if pool is None:
        raise HTTPException(503, "Inventário PostgreSQL desabilitado.", headers=AUTH_HEADERS)
    return pool


@router.get("/{resource}")
async def list_inventory(
    resource: Resource,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    after: UUID | None = None,
):
    tenant = identity["active_tenant_id"]
    if tenant is None:
        raise HTTPException(409, "Selecione um tenant ativo.", headers=AUTH_HEADERS)

    # Somente nomes e colunas estáticos entram no SQL. O contexto vem da sessão.
    query = f"""
        SELECT {COLUMNS[resource]} FROM public.{resource}
        WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id LIMIT $3
    """
    try:
        async with pool.acquire(timeout=5) as connection:
            async with connection.transaction(readonly=True, isolation="repeatable_read"):
                await connection.execute("SET LOCAL ROLE aiops_tenant_reader")
                await connection.fetchval("SELECT pg_catalog.set_config('app.current_tenant_id', $1, true)", str(tenant))
                active = await connection.fetchval("SELECT status = 'active' FROM public.tenants WHERE id = $1", tenant)
                if not active:
                    raise HTTPException(409, "Tenant ativo indisponível.", headers=AUTH_HEADERS)
                rows = await connection.fetch(query, tenant, after, limit + 1)
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError):
        raise HTTPException(503, "Inventário temporariamente indisponível.", headers=AUTH_HEADERS) from None

    response.headers.update(AUTH_HEADERS)
    return {
        "items": [dict(row) for row in rows[:limit]],
        "next_after": rows[limit - 1]["id"] if len(rows) > limit else None,
    }
