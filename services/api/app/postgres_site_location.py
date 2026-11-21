from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import BaseModel, ConfigDict, Field

from .postgres_auth import AUTH_HEADERS
from .postgres_inventory_write import inventory_write_identity, inventory_write_transaction
from .postgres_site_write import SITE_FIELDS, get_site_write_pool


class SiteLocationRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                return await handler(request)
            except RequestValidationError:
                raise HTTPException(422, "Latitude e longitude inválidas.", headers=AUTH_HEADERS) from None

        return handle


router = APIRouter(
    prefix="/api/v1/inventory/sites",
    tags=["inventory"],
    route_class=SiteLocationRoute,
)
Latitude = Annotated[float, Field(strict=True, ge=-90, le=90, allow_inf_nan=False)]
Longitude = Annotated[float, Field(strict=True, ge=-180, le=180, allow_inf_nan=False)]


class VerifyCoordinates(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latitude: Latitude
    longitude: Longitude


@router.patch("/{site_id}/verify-coords")
async def verify_site_coordinates(
    site_id: UUID,
    body: VerifyCoordinates,
    response: Response,
    identity: Annotated[asyncpg.Record, Depends(inventory_write_identity)],
    pool: Annotated[asyncpg.Pool, Depends(get_site_write_pool)],
):
    async with inventory_write_transaction(pool, identity, "aiops_site_writer") as (connection, tenant):
        site = await connection.fetchrow(
            f"""
            UPDATE public.sites
            SET latitude = $3,
                longitude = $4,
                geom = public.ST_SetSRID(public.ST_MakePoint($4, $3), 4326)::public.geography,
                coord_precision = 'manual_verificada',
                coord_verified = true,
                updated_at_utc = now()
            WHERE id = $1 AND tenant_id = $2
            RETURNING {SITE_FIELDS}
            """,
            site_id, tenant, body.latitude, body.longitude,
        )
        if site is None:
            raise HTTPException(404, "Site não encontrado.", headers=AUTH_HEADERS)
        await connection.execute(
            """
            INSERT INTO public.audit_logs (
                tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json
            )
            VALUES ($1, $2, $3, 'SITE_COORDS_VERIFIED', 'site', $4,
                    pg_catalog.jsonb_build_object('latitude', $5::double precision, 'longitude', $6::double precision))
            """,
            tenant, identity["id"], identity["role"], str(site_id), site["latitude"], site["longitude"],
        )
    response.headers.update(AUTH_HEADERS)
    return dict(site)
