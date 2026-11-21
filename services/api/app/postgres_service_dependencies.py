from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import get_inventory_pool, inventory_read_transaction
from .postgres_inventory_write import audit_inventory_write, inventory_write_transaction
from .postgres_service_write import ServiceWriteRoute, get_service_write_pool


router = APIRouter(
    prefix="/api/v1/inventory/services/{service_id}/dependencies",
    tags=["inventory"],
    route_class=ServiceWriteRoute,
)
DEPENDENCY_FIELDS = "id, tenant_id, service_id, asset_id, upstream_service_id, dependency_role, weight, created_at_utc"
DependencyRole = Literal["primary", "redundant", "supporting"]
Weight = Annotated[float, Field(strict=True, gt=0, allow_inf_nan=False)]

WOULD_CREATE_CYCLE = """
WITH RECURSIVE reachable(id) AS (
    SELECT $3::uuid
    UNION
    SELECT d.upstream_service_id
    FROM public.service_dependencies d
    JOIN reachable r ON d.service_id = r.id
    WHERE d.tenant_id = $1 AND d.upstream_service_id IS NOT NULL
)
SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $2)
"""


class CreateDependency(BaseModel):
    model_config = ConfigDict(extra="forbid")

    asset_id: UUID | None = None
    upstream_service_id: UUID | None = None
    dependency_role: DependencyRole = "primary"
    weight: Weight = 1.0


async def require_service(connection: asyncpg.Connection, tenant: UUID, service_id: UUID):
    exists = await connection.fetchval(
        "SELECT EXISTS (SELECT 1 FROM public.services WHERE tenant_id = $1 AND id = $2)",
        tenant, service_id,
    )
    if not exists:
        raise HTTPException(404, "Serviço não encontrado.", headers=AUTH_HEADERS)


@router.get("")
async def list_dependencies(
    service_id: UUID,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    after: UUID | None = None,
):
    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        await require_service(connection, tenant, service_id)
        rows = await connection.fetch(
            """
            SELECT d.id, d.tenant_id, d.service_id, d.asset_id, d.upstream_service_id,
                   d.dependency_role, d.weight, d.created_at_utc,
                   a.name AS asset_name, upstream.name AS upstream_service_name
            FROM public.service_dependencies d
            LEFT JOIN public.assets a ON a.tenant_id = d.tenant_id AND a.id = d.asset_id
            LEFT JOIN public.services upstream ON upstream.tenant_id = d.tenant_id AND upstream.id = d.upstream_service_id
            WHERE d.tenant_id = $1 AND d.service_id = $2 AND ($3::uuid IS NULL OR d.id > $3)
            ORDER BY d.id LIMIT $4
            """,
            tenant, service_id, after, limit + 1,
        )
    response.headers.update(AUTH_HEADERS)
    return {
        "items": [dict(row) for row in rows[:limit]],
        "next_after": rows[limit - 1]["id"] if len(rows) > limit else None,
    }


@router.post("", status_code=201)
async def create_dependency(
    service_id: UUID,
    body: CreateDependency,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_service_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_service_writer") as (connection, tenant):
        await require_service(connection, tenant, service_id)
        if body.asset_id is None and body.upstream_service_id is None:
            raise HTTPException(422, "Informe um ativo ou serviço upstream.", headers=AUTH_HEADERS)
        if body.upstream_service_id is not None:
            # A consulta após o lock enxerga as arestas confirmadas pela transação anterior.
            await connection.execute("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 12012))", str(tenant))
            if await connection.fetchval(WOULD_CREATE_CYCLE, tenant, service_id, body.upstream_service_id):
                raise HTTPException(409, "A dependência criaria um ciclo entre serviços.", headers=AUTH_HEADERS)
        dependency = await connection.fetchrow(
            f"""
            INSERT INTO public.service_dependencies (tenant_id, service_id, asset_id, upstream_service_id, dependency_role, weight)
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING {DEPENDENCY_FIELDS}
            """,
            tenant, service_id, body.asset_id, body.upstream_service_id, body.dependency_role, body.weight,
        )
        await audit_inventory_write(
            connection, tenant, identity, "SERVICE_DEPENDENCY_CREATED", "service_dependency", dependency["id"],
        )
    response.headers.update(AUTH_HEADERS)
    return dict(dependency)


@router.delete("/{dependency_id}", status_code=204)
async def delete_dependency(
    service_id: UUID,
    dependency_id: UUID,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_service_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_service_writer") as (connection, tenant):
        deleted = await connection.fetchval(
            """
            DELETE FROM public.service_dependencies
            WHERE tenant_id = $1 AND service_id = $2 AND id = $3 RETURNING id
            """,
            tenant, service_id, dependency_id,
        )
        if deleted is None:
            raise HTTPException(404, "Dependência não encontrada.", headers=AUTH_HEADERS)
        await audit_inventory_write(
            connection, tenant, identity, "SERVICE_DEPENDENCY_DELETED", "service_dependency", deleted,
        )
    return Response(status_code=204, headers=AUTH_HEADERS)
