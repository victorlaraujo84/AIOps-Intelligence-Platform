from datetime import datetime
from enum import Enum
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class Role(str, Enum):
    SUPER_ADMIN = "super_admin"
    TENANT_ADMIN = "tenant_admin"
    TENANT_OPERATOR = "tenant_operator"
    TENANT_VIEWER = "tenant_viewer"


class HonestState(str, Enum):
    NOT_CONFIGURED = "NOT_CONFIGURED"
    NO_DATA = "NO_DATA"
    SOURCE_STALE = "SOURCE_STALE"
    INSUFFICIENT_DATA = "INSUFFICIENT_DATA"
    MODEL_NOT_VALIDATED = "MODEL_NOT_VALIDATED"
    PREDICTION_UNAVAILABLE = "PREDICTION_UNAVAILABLE"


class CanonicalEventContract(BaseModel):
    tenant_id: UUID
    site_id: Optional[UUID] = None
    asset_id: Optional[UUID] = None
    event_id: UUID
    event_time_utc: datetime
    observed_at_utc: datetime
    ingested_at_utc: datetime
    forecast_issued_at_utc: Optional[datetime] = None
    source: str = Field(min_length=1)
    event_type: str = Field(min_length=1)
    status: str = Field(min_length=1)
    lat: Optional[float] = Field(default=None, ge=-90.0, le=90.0)
    lon: Optional[float] = Field(default=None, ge=-180.0, le=180.0)
    quality_flag: str = "VALID"
    payload: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_forecast_timestamp(self) -> "CanonicalEventContract":
        if "forecast" in self.event_type.lower() and self.forecast_issued_at_utc is None:
            raise ValueError("forecast_issued_at_utc é obrigatório para registros de previsão.")
        return self


class MetricSampleContract(BaseModel):
    tenant_id: UUID
    asset_id: Optional[UUID] = None
    service_id: Optional[UUID] = None
    site_id: Optional[UUID] = None
    idempotency_key: str = Field(min_length=1)
    metric_name: str = Field(min_length=1)
    value_num: float
    unit: str = Field(min_length=1)
    observed_at_utc: datetime
    ingested_at_utc: datetime
    source: str = Field(min_length=1)
    quality_flag: Literal["VALID", "STALE", "SUSPECT", "UNVERIFIED_COORDS"] = "VALID"
    tags: dict[str, Any] = Field(default_factory=dict)


class OperationalLogContract(BaseModel):
    tenant_id: UUID
    asset_id: Optional[UUID] = None
    service_id: Optional[UUID] = None
    site_id: Optional[UUID] = None
    idempotency_key: str = Field(min_length=1)
    severity: Literal["DEBUG", "INFO", "WARN", "ERROR", "FATAL"]
    message: str = Field(min_length=1)
    observed_at_utc: datetime
    ingested_at_utc: datetime
    source: str = Field(min_length=1)
    trace_id: Optional[str] = None
    attributes: dict[str, Any] = Field(default_factory=dict)


class ServiceContract(BaseModel):
    id: UUID
    tenant_id: UUID
    code: str = Field(min_length=1)
    name: str = Field(min_length=1)
    domain: str = Field(min_length=1)
    criticality: Literal["critica", "alta", "media", "baixa"] = "alta"
    sla_target_pct: Optional[float] = Field(default=None, ge=0.0, le=100.0)


class AuthorizedCollectionScopeContract(BaseModel):
    id: UUID
    tenant_id: UUID
    protocol: Literal["snmp_v3", "mqtt", "icmp", "otlp", "http_agent"]
    target_cidr_or_host: str = Field(min_length=1)
    port: Optional[int] = Field(default=None, ge=1, le=65535)
    rate_limit_rpm: int = Field(default=60, ge=1, le=600)
    is_active: bool = True
