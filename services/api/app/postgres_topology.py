from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from .postgres_asset_write import get_asset_write_pool
from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import get_inventory_pool, inventory_read_transaction
from .postgres_inventory_write import (
    Name, audit_inventory_write, inventory_write_identity, inventory_write_transaction, lock_inventory_graph,
)


class TopologyRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "Dados do enlace topológico inválidos.", headers=AUTH_HEADERS) from None

        return handle


router = APIRouter(prefix="/api/v1/inventory/topology", tags=["inventory"], route_class=TopologyRoute)
EDGE_FIELDS = "id, tenant_id, source_asset_id, target_asset_id, link_type, provider_name, capacity_mbps, is_redundant, created_at_utc"
Capacity = Annotated[float, Field(strict=True, ge=0, allow_inf_nan=False)]

WOULD_CREATE_CYCLE = """
WITH RECURSIVE reachable(id) AS (
    SELECT $3::uuid
    UNION
    SELECT e.target_asset_id FROM public.topology_edges e
    JOIN reachable r ON e.source_asset_id = r.id
    WHERE e.tenant_id = $1
)
SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $2)
"""


class CreateEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_asset_id: UUID
    target_asset_id: UUID
    link_type: Name
    provider_name: Name | None = None
    capacity_mbps: Capacity | None = None
    is_redundant: Annotated[bool, Field(strict=True)] = False


@router.get("/edges")
async def list_edges(
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    after: UUID | None = None,
):
    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        rows = await connection.fetch(
            """
            SELECT e.id, e.tenant_id, e.source_asset_id, e.target_asset_id, e.link_type,
                   e.provider_name, e.capacity_mbps, e.is_redundant, e.created_at_utc,
                   source.name AS source_asset_name, source.site_id AS source_site_id,
                   target.name AS target_asset_name, target.site_id AS target_site_id
            FROM public.topology_edges e
            JOIN public.assets source ON source.tenant_id = e.tenant_id AND source.id = e.source_asset_id
            JOIN public.assets target ON target.tenant_id = e.tenant_id AND target.id = e.target_asset_id
            WHERE e.tenant_id = $1 AND ($2::uuid IS NULL OR e.id > $2)
            ORDER BY e.id LIMIT $3
            """,
            tenant, after, limit + 1,
        )
    response.headers.update(AUTH_HEADERS)
    return {
        "items": [dict(row) for row in rows[:limit]],
        "next_after": rows[limit - 1]["id"] if len(rows) > limit else None,
    }


@router.get("/shared-upstream")
async def list_shared_upstream(
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    after: UUID | None = None,
):
    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        rows = await connection.fetch(
            """
            SELECT source_asset_id AS upstream_asset_id, count(DISTINCT target_asset_id) AS downstream_count
            FROM public.topology_edges
            WHERE tenant_id = $1 AND ($2::uuid IS NULL OR source_asset_id > $2)
            GROUP BY source_asset_id
            HAVING count(DISTINCT target_asset_id) > 1
            ORDER BY source_asset_id LIMIT $3
            """,
            tenant, after, limit + 1,
        )
    response.headers.update(AUTH_HEADERS)
    return {
        "items": [dict(row) for row in rows[:limit]],
        "next_after": rows[limit - 1]["upstream_asset_id"] if len(rows) > limit else None,
    }


@router.post("/edges", status_code=201)
async def create_edge(
    body: CreateEdge,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_asset_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_asset_writer") as (connection, tenant):
        await lock_inventory_graph(connection, tenant, "topology")
        if await connection.fetchval(WOULD_CREATE_CYCLE, tenant, body.source_asset_id, body.target_asset_id):
            raise HTTPException(409, "O enlace criaria um ciclo topológico.", headers=AUTH_HEADERS)
        edge = await connection.fetchrow(
            f"""
            INSERT INTO public.topology_edges (
                tenant_id, source_asset_id, target_asset_id, link_type, provider_name, capacity_mbps, is_redundant
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (tenant_id, source_asset_id, target_asset_id, link_type) DO NOTHING
            RETURNING {EDGE_FIELDS}
            """,
            tenant, body.source_asset_id, body.target_asset_id, body.link_type,
            body.provider_name, body.capacity_mbps, body.is_redundant,
        )
        if edge is None:
            raise HTTPException(409, "Este enlace topológico já está cadastrado.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "TOPOLOGY_EDGE_CREATED", "topology_edge", edge["id"])
    response.headers.update(AUTH_HEADERS)
    return dict(edge)


@router.delete("/edges/{edge_id}", status_code=204)
async def delete_edge(
    edge_id: UUID,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_asset_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_asset_writer") as (connection, tenant):
        deleted = await connection.fetchval(
            "DELETE FROM public.topology_edges WHERE tenant_id = $1 AND id = $2 RETURNING id",
            tenant, edge_id,
        )
        if deleted is None:
            raise HTTPException(404, "Enlace não encontrado.", headers=AUTH_HEADERS)
        await audit_inventory_write(connection, tenant, identity, "TOPOLOGY_EDGE_DELETED", "topology_edge", deleted)
    return Response(status_code=204, headers=AUTH_HEADERS)
