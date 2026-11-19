from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load_module(rel_path: str, name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    mod = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(mod)
    return mod


class TestPythonContracts(unittest.TestCase):
    def test_temporal_guard_blocks_future_leakage(self):
        guard = load_module("services/feature-engine/temporal_guard.py", "temporal_guard")
        t = datetime(2026, 11, 18, 12, 0, tzinfo=timezone.utc)
        self.assertTrue(
            guard.is_record_available_at_decision(
                {"ingested_at_utc": t - timedelta(minutes=5), "forecast_issued_at_utc": t - timedelta(hours=1)},
                t,
            )
        )
        self.assertFalse(
            guard.is_record_available_at_decision(
                {"ingested_at_utc": t + timedelta(minutes=1), "forecast_issued_at_utc": None},
                t,
            )
        )
        self.assertFalse(
            guard.is_record_available_at_decision(
                {"ingested_at_utc": t - timedelta(minutes=1), "forecast_issued_at_utc": t + timedelta(minutes=1)},
                t,
            )
        )

    def test_rca_classification(self):
        rca = load_module("services/correlation/rca.py", "rca")
        self.assertEqual(rca.classify_incident_rca(["power_outage"]), "eletrica")
        self.assertEqual(rca.classify_incident_rca(["weather_alert", "power_outage"]), "composta")
        self.assertEqual(rca.classify_incident_rca(["link_down"]), "telecom_outros")

    def test_chronological_embargo(self):
        split = load_module("backtesting/split.py", "split")
        t0 = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
        self.assertFalse(split.validate_chronological_split(t0, t0 + timedelta(hours=4), horizon_hours=6, lookback_hours=6))
        self.assertTrue(split.validate_chronological_split(t0, t0 + timedelta(hours=12), horizon_hours=6, lookback_hours=6))


if __name__ == "__main__":
    unittest.main()
