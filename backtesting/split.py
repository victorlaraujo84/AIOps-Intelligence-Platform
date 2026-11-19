"""
Pipeline de validação e backtesting cronológico com embargo temporal.
"""
from datetime import datetime, timedelta


def validate_chronological_split(
    train_end_utc: datetime,
    val_start_utc: datetime,
    horizon_hours: int,
    lookback_hours: int,
) -> bool:
    required_embargo = timedelta(hours=horizon_hours + lookback_hours)
    return (val_start_utc - train_end_utc) >= required_embargo
