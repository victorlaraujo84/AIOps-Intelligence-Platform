from contextlib import asynccontextmanager
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import HTTPException
from pydantic import StringConstraints

from .postgres_auth import AUTH_HEADERS


Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Criticality = Literal["critica", "alta", "media", "baixa"]
Domain = Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=1, max_length=80)]


@asynccontextmanager
async def inventory_write_transaction(
    pool: asyncpg.Pool,
    identity: asyncpg.Record,
    role: Literal["aiops_site_writer", "aiops_asset_writer", "aiops_service_writer"],
):
    resource_label = {
        "aiops_site_writer": "sites",
        "aiops_asset_writer": "ativos",
        "aiops_service_writer": "serviços",
    }[role]
    if identity["role"] not in {"super_admin", "tenant_admin", "tenant_operator"}:
        raise HTTPException(403, f"Permissão insuficiente para alterar {resource_label}.", headers=AUTH_HEADERS)
    tenant = identity["active_tenant_id"]
    if tenant is None:
        raise HTTPException(409, "Selecione um tenant ativo.", headers=AUTH_HEADERS)

    try:
        async with pool.acquire(timeout=5) as connection:
            async with connection.transaction(isolation="read_committed"):
                await connection.execute(f"SET LOCAL ROLE {role}")
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
        if isinstance(error, asyncpg.UniqueViolationError) and error.constraint_name == "services_tenant_id_code_key":
            raise HTTPException(409, "Já existe um serviço com este código neste tenant.", headers=AUTH_HEADERS) from None
        if isinstance(error, asyncpg.ForeignKeyViolationError) and error.constraint_name == "assets_site_id_fkey":
            raise HTTPException(422, "Site informado indisponível neste tenant.", headers=AUTH_HEADERS) from None
        if isinstance(error, asyncpg.ForeignKeyViolationError):
            if error.constraint_name == "sites_concession_id_fkey":
                raise HTTPException(422, "Concessão indisponível neste tenant.", headers=AUTH_HEADERS) from None
            if error.constraint_name == "sites_locality_type_id_fkey":
                raise HTTPException(422, "Tipo de localidade indisponível neste tenant.", headers=AUTH_HEADERS) from None
            if error.constraint_name == "assets_category_id_fkey":
                raise HTTPException(422, "Categoria indisponível neste tenant.", headers=AUTH_HEADERS) from None
            if error.constraint_name in {"topology_edges_source_asset_id_fkey", "topology_edges_target_asset_id_fkey"}:
                raise HTTPException(422, "Ativo do enlace indisponível neste tenant.", headers=AUTH_HEADERS) from None
            if error.constraint_name == "service_dependencies_service_id_fkey":
                raise HTTPException(404, "Serviço não encontrado.", headers=AUTH_HEADERS) from None
            if error.constraint_name in {"service_dependencies_asset_id_fkey", "service_dependencies_upstream_service_id_fkey"}:
                raise HTTPException(422, "Alvo da dependência indisponível neste tenant.", headers=AUTH_HEADERS) from None
        raise HTTPException(503, f"Gravação de {resource_label} temporariamente indisponível.", headers=AUTH_HEADERS) from None


async def lock_inventory_graph(
    connection: asyncpg.Connection, tenant: UUID, graph: Literal["service_dependencies", "topology"],
):
    # A consulta seguinte enxerga as arestas confirmadas pela transação anterior.
    lock_namespace = {"service_dependencies": 12012, "topology": 12013}[graph]
    await connection.execute(
        "SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, $2))",
        str(tenant), lock_namespace,
    )


async def audit_inventory_write(
    connection: asyncpg.Connection, tenant: UUID, identity: asyncpg.Record,
    action: str, resource: Literal["site", "asset", "service", "service_dependency", "topology_edge", "asset_category", "concession", "locality_type"], resource_id: UUID,
):
    await connection.execute(
        """
        INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        tenant, identity["id"], identity["role"], action, resource, str(resource_id),
    )
