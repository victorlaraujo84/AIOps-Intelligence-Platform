import asyncio
from contextlib import asynccontextmanager

import asyncpg
from fastapi import FastAPI, Request, Response

from .postgres_asset_categories import router as postgres_asset_categories_router
from .postgres_asset_write import postgres_asset_write_lifespan, router as postgres_asset_write_router
from .postgres_auth import postgres_auth_lifespan, router as postgres_auth_router
from .postgres_connector_ingest import router as postgres_ingest_router
from .postgres_incidents import router as postgres_incidents_router
from .postgres_inventory import postgres_inventory_lifespan, router as postgres_inventory_router
from .postgres_webhooks import router as postgres_webhooks_router
from .postgres_itsm import router as postgres_itsm_router
from .postgres_service_dependencies import router as postgres_service_dependencies_router
from .postgres_service_write import postgres_service_write_lifespan, router as postgres_service_write_router
from .postgres_site_catalog import router as postgres_site_catalog_router
from .postgres_site_location import router as postgres_site_location_router
from .postgres_site_map import router as postgres_site_map_router
from .postgres_site_write import postgres_site_write_lifespan, router as postgres_site_write_router
from .postgres_tenant_users import router as postgres_tenant_users_router
from .postgres_topology import router as postgres_topology_router
from .schemas import HonestState


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with (
        postgres_auth_lifespan(app),
        postgres_inventory_lifespan(app),
        postgres_site_write_lifespan(app),
        postgres_asset_write_lifespan(app),
        postgres_service_write_lifespan(app),
    ):
        yield


app = FastAPI(
    title="AIOps Intelligence Platform — Core API",
    version="1.0.0",
    lifespan=lifespan,
    description="Backend modular FastAPI multi-tenant com RLS, ingestão espaço-temporal, RCA e ML local.",
)

app.include_router(postgres_auth_router)
app.include_router(postgres_tenant_users_router)
app.include_router(postgres_webhooks_router)
app.include_router(postgres_inventory_router)
app.include_router(postgres_incidents_router)
app.include_router(postgres_ingest_router)
app.include_router(postgres_itsm_router)
app.include_router(postgres_site_write_router)
app.include_router(postgres_site_catalog_router)
app.include_router(postgres_site_location_router)
app.include_router(postgres_site_map_router)
app.include_router(postgres_asset_write_router)
app.include_router(postgres_asset_categories_router)
app.include_router(postgres_service_write_router)
app.include_router(postgres_service_dependencies_router)
app.include_router(postgres_topology_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "aiops-fastapi"}


@app.get("/ready")
async def ready(request: Request, response: Response) -> dict[str, str]:
    auth = request.app.state.postgres_auth
    inventory = request.app.state.inventory_pool
    if auth is not None and inventory is not None:
        try:
            await asyncio.gather(auth.pool.fetchval("SELECT 1", timeout=2), inventory.fetchval("SELECT 1", timeout=2))
            return {"status": "ok"}
        except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError, TimeoutError):
            pass
    response.status_code = 503
    return {"status": "degraded"}


@app.get("/api/v1/ml/governance-status")
async def ml_governance_status() -> dict[str, object]:
    return {
        "model_status": HonestState.MODEL_NOT_VALIDATED.value,
        "prediction_status": HonestState.PREDICTION_UNAVAILABLE.value,
        "shadow_mode": True,
        "decision": "NO-GO",
    }
