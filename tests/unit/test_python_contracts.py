from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


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

    def test_rca_classification_multidomain(self):
        rca = load_module("services/correlation/rca.py", "rca")
        self.assertEqual(rca.classify_incident_rca(["power_outage"]), "eletrica")
        self.assertEqual(rca.classify_incident_rca(["weather_alert", "power_outage"]), "composta")
        self.assertEqual(rca.classify_incident_rca(["link_down"]), "telecom_outros")
        self.assertEqual(rca.classify_incident_rca(["http_500_spike"], domain="ti"), "ti_aplicacao")
        self.assertEqual(rca.classify_incident_rca(["mqtt_offline"], domain="iot"), "iot_sensor")

    def test_chronological_embargo(self):
        split = load_module("backtesting/split.py", "split")
        t0 = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
        self.assertFalse(split.validate_chronological_split(t0, t0 + timedelta(hours=4), horizon_hours=6, lookback_hours=6))
        self.assertTrue(split.validate_chronological_split(t0, t0 + timedelta(hours=12), horizon_hours=6, lookback_hours=6))

    def test_native_collectors_scope_authorization(self):
        nc = load_module("services/ingestion/native_collectors.py", "native_collectors")
        scopes = [
            nc.AuthorizedScope(scope_id="sc-1", tenant_id="t1", protocol="snmp_v3", target_cidr_or_host="10.10.0.0/24"),
            nc.AuthorizedScope(scope_id="sc-2", tenant_id="t2", protocol="icmp", target_cidr_or_host="192.168.1.10"),
        ]
        ok_job = nc.NativeCollectionJob(tenant_id="t1", protocol="snmp_v3", target="10.10.0.44")
        allowed, matched, _ = nc.authorize_collection_job(ok_job, scopes)
        self.assertTrue(allowed)
        self.assertIsNotNone(matched)

        # Bloqueia alvo fora de CIDR e isolamento cross-tenant
        bad_ip = nc.NativeCollectionJob(tenant_id="t1", protocol="snmp_v3", target="10.10.5.44")
        self.assertFalse(nc.authorize_collection_job(bad_ip, scopes)[0])

        cross_tenant = nc.NativeCollectionJob(tenant_id="t1", protocol="icmp", target="192.168.1.10")
        self.assertFalse(nc.authorize_collection_job(cross_tenant, scopes)[0])

    def test_ml_shadow_gate_and_evaluator(self):
        ml = load_module("services/ml-engine/train_and_evaluate.py", "train_and_evaluate")
        # Dataset pequeno deve retornar INSUFFICIENT_DATA / NO-GO / Shadow Mode
        res_small = ml.train_and_evaluate_local([{"observed_at_utc": "2026-11-19T00:00:00Z", "label": 1}])
        self.assertEqual(res_small["status"], "INSUFFICIENT_DATA")
        self.assertEqual(res_small["decision"], "NO-GO")
        self.assertTrue(res_small["shadow_mode"])

        # Dataset sintético apenas para validar lógica matemática do gate sem aprovação humana -> permanece Shadow/MODEL_NOT_VALIDATED
        base = datetime(2026, 11, 1, 0, 0, tzinfo=timezone.utc)
        rows = []
        for i in range(120):
            is_pos = 1 if i % 6 == 0 else 0
            rows.append(
                {
                    "observed_at_utc": (base + timedelta(hours=i)).isoformat(),
                    "site_or_asset_group": f"G{i % 4}",
                    "label": is_pos,
                    "rule_score": 0.85 if is_pos else 0.1,
                }
            )
        res_eval = ml.train_and_evaluate_local(rows, human_approved=False)
        self.assertEqual(res_eval["status"], "MODEL_NOT_VALIDATED")
        self.assertTrue(res_eval["shadow_mode"])


if __name__ == "__main__":
    unittest.main()
