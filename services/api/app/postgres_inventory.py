from contextlib import asynccontextmanager
from datetime import datetime, timezone
import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Header, Query, Request, Response

from .postgres_auth import AUTH_HEADERS, get_current_session


Resource = Literal["sites", "assets", "services", "asset-categories", "concessions", "locality-types", "connectors"]
router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])
COLUMNS = {
    "connectors": "id, tenant_id, connector_type, name, status, last_sync_at_utc",
    "asset-categories": "id, tenant_id, code, label, domain, created_at_utc",
    "concessions": "id, tenant_id, code, name, region, description, created_at_utc",
    "locality-types": "id, tenant_id, code, label, description, created_at_utc",
    "sites": (
        "id, tenant_id, concession_id, locality_type_id, code, name, address, cep, municipality, uf, "
        "latitude, longitude, coord_precision, coord_verified, criticality"
    ),
    "assets": (
        "id, tenant_id, site_id, category_id, name, hostname, domain, georeference_mode, asset_type_code, "
        "criticality, operational_state, host(ip_address) AS ip_address, vendor, model, provider_name, redundancy_group"
    ),
    "services": "id, tenant_id, code, name, domain, criticality, owner_team, sla_target_pct, operational_state, description",
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
    OR has_any_column_privilege(current_user, 'public.concessions', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.locality_types', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.assets', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.asset_categories', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.services', 'SELECT')
  )
FROM pg_roles r WHERE r.rolname = current_user
"""


@asynccontextmanager
async def inventory_role_pool(dsn: str, role_query: str, role_error: str):
    pool = None
    try:
        try:
            pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4, timeout=5, command_timeout=5)
            allowed = await pool.fetchval(role_query, timeout=5)
        except Exception:
            raise RuntimeError("Falha ao iniciar o inventário PostgreSQL. Confira o DSN e as migrações.") from None
        if not allowed:
            raise RuntimeError(role_error)
        yield pool
    finally:
        if pool is not None:
            await pool.close()


@asynccontextmanager
async def postgres_inventory_lifespan(app: FastAPI):
    dsn = os.environ.get("AIOPS_POSTGRES_INVENTORY_DSN", "")
    app.state.inventory_pool = None
    if not dsn:
        yield
        return
    if app.state.postgres_auth is None:
        raise RuntimeError("O inventário exige a autenticação PostgreSQL configurada.")

    async with inventory_role_pool(
        dsn, CHECK_READER_ROLE, "Configure uma conta que possa assumir apenas aiops_tenant_reader sem herdar acesso.",
    ) as pool:
        app.state.inventory_pool = pool
        try:
            yield
        finally:
            app.state.inventory_pool = None


def get_inventory_pool(request: Request) -> asyncpg.Pool:
    pool = request.app.state.inventory_pool
    if pool is None:
        raise HTTPException(503, "Inventário PostgreSQL desabilitado.", headers=AUTH_HEADERS)
    return pool


@asynccontextmanager
async def inventory_read_transaction(pool: asyncpg.Pool, identity: asyncpg.Record):
    tenant = identity["active_tenant_id"]
    if tenant is None:
        raise HTTPException(409, "Selecione um tenant ativo.", headers=AUTH_HEADERS)

    try:
        async with pool.acquire(timeout=5) as connection:
            async with connection.transaction(readonly=True, isolation="repeatable_read"):
                await connection.execute("SET LOCAL ROLE aiops_tenant_reader")
                await connection.fetchval("SELECT pg_catalog.set_config('app.current_tenant_id', $1, true)", str(tenant))
                active = await connection.fetchval("SELECT status = 'active' FROM public.tenants WHERE id = $1", tenant)
                if not active:
                    raise HTTPException(409, "Tenant ativo indisponível.", headers=AUTH_HEADERS)
                yield connection, tenant
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError):
        raise HTTPException(503, "Inventário temporariamente indisponível.", headers=AUTH_HEADERS) from None


Feed = Literal["events", "incidents", "metrics", "logs", "anomalies"]
FEEDS = {
    "audit": ("audit_logs", "created_at_utc",
              "actor_role, action, resource_type, resource_id"),
    "events": ("canonical_events", "observed_at_utc", "event_type, status, source, quality_flag"),
    "incidents": ("incidents", "opened_at_utc", "title, status, severity, impacted_services_count"),
    "metrics": ("metric_samples", "observed_at_utc", "metric_name, value_num, unit, source, quality_flag"),
    "logs": ("operational_logs", "observed_at_utc", "severity, left(message, 1000) AS message, source"),
    "anomalies": ("anomaly_detections", "detected_at_utc", "metric_name, severity, status, z_score"),
}


@router.get("/audit")
async def list_audit(
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    expected_tenant: Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    after: Annotated[str | None, Query(max_length=90)] = None,
):
    return await read_feed("audit", response, identity, pool, expected_tenant, limit, after)


@router.get("/feed/{resource}")
async def list_feed(
    resource: Feed,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    expected_tenant: Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")],
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    after: Annotated[str | None, Query(max_length=90)] = None,
):
    return await read_feed(resource, response, identity, pool, expected_tenant, limit, after)


async def read_feed(resource, response, identity, pool, expected_tenant, limit, after):
    if identity["active_tenant_id"] != expected_tenant:
        raise HTTPException(409, "Selecione ou confirme o tenant ativo.", headers=AUTH_HEADERS)

    before_time = None
    before_id = None
    if after is not None:
        try:
            timestamp, identifier = after.split("~", 1)
            before_time = datetime.fromisoformat(timestamp)
            if before_time.tzinfo is None:
                raise ValueError("timestamp sem fuso")
            before_time = before_time.astimezone(timezone.utc)
            before_id = UUID(identifier)
        except (ValueError, OverflowError):
            raise HTTPException(422, "Cursor inválido.", headers=AUTH_HEADERS) from None

    table, timestamp_column, fields = FEEDS[resource]
    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        rows = await connection.fetch(
            f"""
            SELECT id, tenant_id, {timestamp_column} AS created_at_utc, {fields}
            FROM public.{table}
            WHERE tenant_id = $1
              AND ($2::timestamptz IS NULL OR ({timestamp_column}, id) < ($2::timestamptz, $3::uuid))
            ORDER BY {timestamp_column} DESC, id DESC
            LIMIT $4
            """,
            tenant, before_time, before_id, limit + 1,
        )

    cursor = None
    if len(rows) > limit:
        last = rows[limit - 1]
        cursor = f"{last['created_at_utc'].isoformat()}~{last['id']}"
    response.headers.update(AUTH_HEADERS)
    return {"items": [dict(row) for row in rows[:limit]], "next_after": cursor}


@router.get("/{resource}")
async def list_inventory(
    resource: Resource,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    after: UUID | None = None,
):
    # Somente nomes e colunas estáticos entram no SQL. O contexto vem da sessão.
    table = resource.replace("-", "_")
    query = f"""
        SELECT {COLUMNS[resource]} FROM public.{table}
        WHERE tenant_id = $1 AND ($2::uuid IS NULL OR id > $2)
        ORDER BY id LIMIT $3
    """
    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        rows = await connection.fetch(query, tenant, after, limit + 1)

    response.headers.update(AUTH_HEADERS)
    return {
        "items": [dict(row) for row in rows[:limit]],
        "next_after": rows[limit - 1]["id"] if len(rows) > limit else None,
    }
