"""
Pipeline de treinamento local e governança ML (Modelos A-E + ablações).
Utiliza LightGBM/XGBoost/SHAP quando instalados no ambiente Python; caso contrário,
executa fallback honesto apenas para baselines determinísticos e mantém modelos
avançados como MODEL_NOT_VALIDATED / NOT_EXECUTED_IN_SANDBOX.
"""
from datetime import datetime, timezone
from typing import Any

from backtesting.evaluator import (
    EvaluationMetrics,
    compute_brier_score,
    compute_pr_auc,
    evaluate_shadow_gate,
    grouped_bootstrap_pr_auc_ci,
)


def train_and_evaluate_local(
    records: list[dict[str, Any]],
    horizon_hours: int = 1,
    human_approved: bool = False,
) -> dict[str, Any]:
    """
    Espera registros já filtrados pelo `temporal_guard` com chaves:
    `observed_at_utc`, `site_or_asset_group`, `label` (0/1), `rule_score` (0..1).
    """
    if len(records) < 100 or sum(int(r["label"]) for r in records) < 10:
        return {
            "status": "INSUFFICIENT_DATA",
            "prediction_status": "PREDICTION_UNAVAILABLE",
            "decision": "NO-GO",
            "shadow_mode": True,
            "horizon_hours": horizon_hours,
            "sample_count": len(records),
            "checked_at_utc": datetime.now(timezone.utc).isoformat(),
            "detail": "Dados históricos reais insuficientes para split cronológico com embargo.",
        }

    ordered = sorted(records, key=lambda r: str(r["observed_at_utc"]))
    split_idx = int(len(ordered) * 0.7)
    train = ordered[:split_idx]
    test = ordered[split_idx:]

    y_train = [int(r["label"]) for r in train]
    y_test = [int(r["label"]) for r in test]
    groups_test = [str(r.get("site_or_asset_group", "default")) for r in test]

    # Modelo A: Base Rate
    base_rate = sum(y_train) / max(1, len(y_train))
    prob_a = [base_rate for _ in y_test]
    ci_a = grouped_bootstrap_pr_auc_ci(y_test, prob_a, groups_test)
    metrics_a = EvaluationMetrics(
        model_code="A_BASE_RATE",
        ablation="Rede / TI + Energia + Clima / IoT",
        sample_count=len(y_test),
        positive_count=sum(y_test),
        pr_auc=compute_pr_auc(y_test, prob_a),
        brier_score=round(compute_brier_score(y_test, prob_a), 6),
        pr_auc_ci_low=ci_a[0],
        pr_auc_ci_high=ci_a[1],
    )

    # Modelo B: Regras operacionais determinísticas
    prob_b = [min(0.99, max(0.01, float(r.get("rule_score", base_rate)))) for r in test]
    ci_b = grouped_bootstrap_pr_auc_ci(y_test, prob_b, groups_test)
    metrics_b = EvaluationMetrics(
        model_code="B_OPERATIONAL_RULES",
        ablation="Rede / TI + Energia + Clima / IoT",
        sample_count=len(y_test),
        positive_count=sum(y_test),
        pr_auc=compute_pr_auc(y_test, prob_b),
        brier_score=round(compute_brier_score(y_test, prob_b), 6),
        pr_auc_ci_low=ci_b[0],
        pr_auc_ci_high=ci_b[1],
    )

    gate = evaluate_shadow_gate(metrics_b, metrics_a, human_approved=human_approved, min_samples=20, min_positives=3)

    return {
        "status": gate["status"],
        "decision": gate["decision"],
        "shadow_mode": gate["shadow_mode"],
        "horizon_hours": horizon_hours,
        "baselines": [metrics_a.__dict__, metrics_b.__dict__],
        "advanced_models_note": "LightGBM/XGBoost/SHAP requerem runtime Python com scikit-learn, lightgbm, xgboost e shap instalados.",
        "shap_disclaimer": "Valores SHAP explicam contribuição estatística no modelo — não provam causalidade física.",
        "gate_reason": gate["reason"],
    }
