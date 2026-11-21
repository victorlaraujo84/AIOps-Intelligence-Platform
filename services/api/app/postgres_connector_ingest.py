import json
import os
from collections.abc import Sequence
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


class ObservedInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    idempotency_key: Key
    source: Label
    observed_at_utc: AwareDatetime
    asset_id: UUID | None = None
    site_id: UUID | None = None


class EventInput(ObservedInput):
    event_type: Label
    status: EventStatus
    event_time_utc: AwareDatetime
    forecast_issued_at_utc: AwareDatetime | None = None
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


class MetricInput(ObservedInput):
    service_id: UUID | None = None
    metric_name: Label
    value_num: Annotated[float, Field(strict=True, allow_inf_nan=False)]
    unit: Label
    quality_flag: Literal["VALID", "STALE", "SUSPECT", "UNVERIFIED_COORDS"] = "VALID"
    tags: dict = Field(default_factory=dict)


class LogInput(ObservedInput):
    service_id: UUID | None = None
    severity: Literal["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]
    message: Annotated[str, StringConstraints(min_length=1, max_length=16000)]
    trace_id: Annotated[str, StringConstraints(max_length=128)] | None = None
    attributes: dict = Field(default_factory=dict)


class MetricBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    metrics: Annotated[list[MetricInput], Field(min_length=1, max_length=100)]


class LogBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    logs: Annotated[list[LogInput], Field(min_length=1, max_length=100)]


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
            "P1032": (429, "Aguarde 30 segundos entre sincronizações do mesmo conector."),
            "P1031": (422, "O ativo, serviço ou site informado está fora do escopo do lote."),
            "22023": (422, "Dados de ingestão inválidos."),
            "22P05": (422, "Conteúdo do lote inválido."),
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
    events = encode_records(body.events)
    row = await connector_query(
        auth, token, "SELECT * FROM aiops_auth.ingest_connector_events($1, $2, $3, $4::jsonb)",
        tenant, connector_id, events,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


def encode_records(records: Sequence[ObservedInput]) -> str:
    try:
        payload = json.dumps([item.model_dump(mode="json") for item in records], ensure_ascii=False, allow_nan=False)
        if len(payload.encode("utf-8")) > 512 * 1024:
            raise ValueError
    except (ValueError, UnicodeError):
        raise HTTPException(422, "Conteúdo do lote inválido.", headers=AUTH_HEADERS) from None
    return payload


async def persist_telemetry(
    kind: Literal["metrics", "logs"], records: Sequence[ObservedInput], connector_id: UUID,
    response: Response, tenant: UUID, auth: PostgresAuth, token: str,
):
    row = await connector_query(
        auth, token, "SELECT * FROM aiops_auth.ingest_connector_telemetry($1, $2, $3, $4, $5::jsonb)",
        tenant, connector_id, kind, encode_records(records),
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


@router.post("/{connector_id}/ingest/metrics", status_code=201)
async def ingest_metrics(
    connector_id: UUID, body: MetricBatch, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token,
):
    return await persist_telemetry("metrics", body.metrics, connector_id, response, tenant, auth, token)


@router.post("/{connector_id}/ingest/logs", status_code=201)
async def ingest_logs(
    connector_id: UUID, body: LogBatch, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token,
):
    return await persist_telemetry("logs", body.logs, connector_id, response, tenant, auth, token)


WeatherValue = Annotated[float, Field(strict=True, allow_inf_nan=False)]


class OpenMeteoConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    site_id: UUID
    public_coordinates_authorized: Literal[True]
    non_commercial_use_confirmed: Literal[True]


class OpenMeteoReadings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    temperature_2m: WeatherValue
    precipitation: WeatherValue
    wind_gusts_10m: WeatherValue
    surface_pressure: WeatherValue


class OpenMeteoResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: UUID
    observed_at: AwareDatetime | None = None
    readings: OpenMeteoReadings | None = None
    failure: Literal["UPSTREAM_UNAVAILABLE", "UPSTREAM_INVALID"] | None = None

    @model_validator(mode="after")
    def validate_result(self):
        if self.failure is None:
            if self.observed_at is None or self.readings is None:
                raise ValueError("Informe as condições e o horário do modelo.")
        elif self.observed_at is not None or self.readings is not None:
            raise ValueError("Uma coleta que falhou não deve conter medições.")
        return self


@router.post("/open-meteo", status_code=201)
async def configure_open_meteo(body: OpenMeteoConfig, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token):
    row = await connector_query(
        auth, token, "SELECT aiops_auth.configure_open_meteo($1, $2, $3, $4) AS id", tenant, body.site_id, body.name,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


@router.post("/{connector_id}/open-meteo/disable")
async def disable_open_meteo(connector_id: UUID, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token):
    row = await connector_query(
        auth, token, "SELECT aiops_auth.disable_open_meteo($1, $2, $3) AS disabled", tenant, connector_id,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


@router.post("/{connector_id}/open-meteo/begin")
async def begin_open_meteo(connector_id: UUID, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token):
    row = await connector_query(
        auth, token, "SELECT * FROM aiops_auth.begin_open_meteo($1, $2, $3)", tenant, connector_id,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


@router.post("/{connector_id}/open-meteo/finish")
async def finish_open_meteo(
    connector_id: UUID, body: OpenMeteoResult, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token,
):
    readings = body.readings.model_dump_json() if body.readings else None
    row = await connector_query(
        auth, token, "SELECT * FROM aiops_auth.finish_open_meteo($1, $2, $3, $4, $5, $6::jsonb, $7)",
        tenant, connector_id, body.run_id, body.observed_at, readings, body.failure,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


class OpenMeteoSchedule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    interval_minutes: Literal[15, 30, 60, 180] | None


@router.get("/{connector_id}/open-meteo/schedule")
async def get_open_meteo_schedule(connector_id: UUID, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token):
    row = await connector_query(
        auth, token, "SELECT * FROM aiops_auth.open_meteo_schedule($1, $2, $3)", tenant, connector_id,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)


@router.post("/{connector_id}/open-meteo/schedule")
async def set_open_meteo_schedule(
    connector_id: UUID, body: OpenMeteoSchedule, response: Response, tenant: ExpectedTenant, auth: Auth, token: Token,
):
    row = await connector_query(
        auth, token, "SELECT aiops_auth.set_open_meteo_schedule($1, $2, $3, $4) AS saved",
        tenant, connector_id, body.interval_minutes,
    )
    response.headers.update(AUTH_HEADERS)
    return dict(row)
