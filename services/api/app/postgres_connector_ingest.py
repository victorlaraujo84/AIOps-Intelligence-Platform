import json
import os
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Response
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .postgres_auth import AUTH_HEADERS, PostgresAuth, get_auth, get_token, unauthorized


router = APIRouter(prefix="/api/v1/inventory/connectors", tags=["ingestion"])
ExpectedTenant = Annotated[UUID, Header(alias="X-AIOps-Expected-Tenant")]
Auth = Annotated[PostgresAuth, Depends(get_auth)]
Token = Annotated[str, Depends(get_token)]

Key = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Label = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
EventStatus = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]


class ConnectorInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Label


class EventInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    idempotency_key: Key
    source: Label
    event_type: Label
    status: EventStatus
    event_time_utc: AwareDatetime
    observed_at_utc: AwareDatetime
    forecast_issued_at_utc: AwareDatetime | None = None
    asset_id: UUID | None = None
    site_id: UUID | None = None
    lat: Annotated[float, Field(ge=-90, le=90, allow_inf_nan=False)] | None = None
    lon: Annotated[float, Field(ge=-180, le=180, allow_inf_nan=False)] | None = None
    quality_flag: Literal["VALID", "STALE", "SUSPECT", "UNVERIFIED_COORDS"] = "VALID"
    payload: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_forecast_time(self):
        if "forecast" in self.event_type.lower() and self.forecast_issued_at_utc is None:
            raise ValueError("Informe o horário de emissão da previsão.")
        return self


class EventBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    events: Annotated[list[EventInput], Field(min_length=1, max_length=100)]


async def connector_query(auth, token, query, tenant, *args):
    if os.environ.get("AIOPS_POSTGRES_CONNECTOR_WRITES") != "true":
        raise HTTPException(404, "Gravação de conectores desabilitada.", headers=AUTH_HEADERS)
    try:
        return await auth.pool.fetchrow(query, auth.token_hash(token), tenant, *args, timeout=5)
    except asyncpg.PostgresError as error:
        if error.sqlstate == "28000":
            raise unauthorized() from None
        errors = {
            "42501": (403, "Permissão insuficiente para a operação."),
            "P1001": (409, "Selecione ou confirme o tenant ativo."),
            "P1030": (404, "Conector indisponível neste tenant."),
            "P1031": (422, "O ativo ou site informado está fora do escopo do lote."),
            "22023": (422, "Dados de ingestão inválidos."),
            "23503": (422, "O recurso relacionado deixou de estar disponível."),
        }
        status, message = errors.get(error.sqlstate, (503, "Ingestão temporariamente indisponível."))
    except (asyncpg.InterfaceError, OSError, TimeoutError):
        status, message = 503, "Ingestão temporariamente indisponível."
    raise HTTPException(status, message, headers=AUTH_HEADERS) from None


@router.post("", status_code=201)
async def create_connector(body: ConnectorInput, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token):
    row = await connector_query(
        auth, token, "SELECT aiops_auth.create_event_connector($1, $2, $3) AS id", tenant, body.name,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


@router.post("/{connector_id}/ingest", status_code=201)
async def ingest_events(
    connector_id: UUID, body: EventBatch, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token,
):
    try:
        events = json.dumps(body.model_dump(mode="json")["events"], ensure_ascii=False, allow_nan=False)
        if "\\u0000" in events or len(events.encode("utf-8")) > 512 * 1024:
            raise ValueError
    except (ValueError, UnicodeError):
        raise HTTPException(422, "Conteúdo do lote inválido.", headers=AUTH_HEADERS) from None
    row = await connector_query(
        auth, token, "SELECT * FROM aiops_auth.ingest_connector_events($1, $2, $3, $4::jsonb)",
        tenant, connector_id, events,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)
