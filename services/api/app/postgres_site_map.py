from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from .postgres_auth import AUTH_HEADERS, get_current_session
from .postgres_inventory import get_inventory_pool, inventory_read_transaction


router = APIRouter(prefix="/api/v1/inventory/sites", tags=["inventory"])
Latitude = Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)]

MAP_QUERY = """
SELECT id, code, name, municipality, uf, criticality, coord_precision, latitude, longitude
FROM public.sites
WHERE tenant_id = $1 AND coord_verified AND geom IS NOT NULL
  AND latitude BETWEEN $4 AND $5
  AND (longitude BETWEEN $2 AND $3 OR longitude BETWEEN $6 AND $7)
  AND ($8::uuid IS NULL OR id > $8)
ORDER BY id LIMIT $9
"""


class MapQuery(BaseModel):
    west: Longitude
    south: Latitude
    east: Longitude
    north: Latitude
    after: UUID | None = None
    limit: Annotated[int, Field(ge=1, le=500)] = 250


def longitude_windows(west: float, east: float) -> tuple[float, float, float | None, float | None]:
    if west > east:
        return west, 180, -180, east
    # -180° e +180° representam o mesmo meridiano.
    if west == -180 and east < 180:
        return west, east, 180, 180
    if east == 180 and west > -180:
        return west, east, -180, -180
    return west, east, None, None


@router.get("/map")
async def list_site_markers(
    response: Response,
    query: Annotated[MapQuery, Query()],
    identity: Annotated[asyncpg.Record, Depends(get_current_session)],
    pool: Annotated[asyncpg.Pool, Depends(get_inventory_pool)],
):
    if query.south >= query.north or query.west == query.east or (query.west, query.east) == (180, -180):
        raise HTTPException(422, "Área do mapa inválida.", headers=AUTH_HEADERS)

    west, east, second_west, second_east = longitude_windows(query.west, query.east)
    async with inventory_read_transaction(pool, identity) as (connection, tenant):
        rows = await connection.fetch(
            MAP_QUERY,
            tenant, west, east, query.south, query.north, second_west, second_east, query.after, query.limit + 1,
        )
    response.headers.update(AUTH_HEADERS)
    return {
        "items": [dict(row) for row in rows[:query.limit]],
        "next_after": rows[query.limit - 1]["id"] if len(rows) > query.limit else None,
    }
