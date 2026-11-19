"""
Feature Engine versionado e anti-leakage.
Garante que apenas observações com ingested_at_utc <= decision_time_utc
e previsões com forecast_issued_at_utc <= decision_time_utc sejam elegíveis.
"""
from datetime import datetime
from typing import Any


def is_record_available_at_decision(
    record: dict[str, Any],
    decision_time_utc: datetime,
) -> bool:
    ingested_at = record.get("ingested_at_utc")
    if not isinstance(ingested_at, datetime) or ingested_at > decision_time_utc:
        return False

    forecast_issued_at = record.get("forecast_issued_at_utc")
    if forecast_issued_at is not None:
        if not isinstance(forecast_issued_at, datetime) or forecast_issued_at > decision_time_utc:
            return False

    return True
