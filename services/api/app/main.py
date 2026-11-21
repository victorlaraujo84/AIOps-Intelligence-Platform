from contextlib import asynccontextmanager

from fastapi import FastAPI

from .postgres_auth import postgres_auth_lifespan, router as postgres_auth_router
from .postgres_inventory import postgres_inventory_lifespan, router as postgres_inventory_router
from .postgres_site_write import postgres_site_write_lifespan, router as postgres_site_write_router
from .schemas import HonestState


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with (
        postgres_auth_lifespan(app),
        postgres_inventory_lifespan(app),
        postgres_site_write_lifespan(app),
    ):
        yield


app = FastAPI(
    title="AIOps Intelligence Platform — Core API",
    version="1.0.0",
    lifespan=lifespan,
    description="Backend modular FastAPI multi-tenant com RLS, ingestão espaço-temporal, RCA e ML local.",
)

app.include_router(postgres_auth_router)
app.include_router(postgres_inventory_router)
app.include_router(postgres_site_write_router)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "aiops-fastapi"}


@app.get("/api/v1/ml/governance-status")
async def ml_governance_status() -> dict[str, object]:
    return {
        "model_status": HonestState.MODEL_NOT_VALIDATED.value,
        "prediction_status": HonestState.PREDICTION_UNAVAILABLE.value,
        "shadow_mode": True,
        "decision": "NO-GO",
    }
