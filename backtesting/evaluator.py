"""
Avaliação cronológica rigorosa, anti-leakage e comparação de baselines (A-E) + ablações.
Respeita regra inegociável: se não houver dados históricos suficientes ou aprovação humana,
mantém o gate em NO-GO / MODEL_NOT_VALIDATED / Shadow Mode.
"""
from dataclasses import dataclass
import math
import random
from typing import Sequence


@dataclass(frozen=True)
class EvaluationMetrics:
    model_code: str
    ablation: str
    sample_count: int
    positive_count: int
    pr_auc: float
    brier_score: float
    pr_auc_ci_low: float
    pr_auc_ci_high: float


def compute_brier_score(y_true: Sequence[int], y_prob: Sequence[float]) -> float:
    if not y_true:
        raise ValueError("y_true vazio")
    return sum((yt - yp) ** 2 for yt, yp in zip(y_true, y_prob)) / len(y_true)


def compute_pr_auc(y_true: Sequence[int], y_prob: Sequence[float]) -> float:
    if not y_true:
        return 0.0
    positives = sum(y_true)
    if positives == 0:
        return 0.0

    paired = sorted(zip(y_prob, y_true), key=lambda x: x[0], reverse=True)
    tp = 0
    fp = 0
    prev_recall = 0.0
    area = 0.0

    for _, label in paired:
        if label == 1:
            tp += 1
        else:
            fp += 1
        recall = tp / positives
        precision = tp / (tp + fp)
        area += (recall - prev_recall) * precision
        prev_recall = recall

    return round(area, 6)


def grouped_bootstrap_pr_auc_ci(
    y_true: Sequence[int],
    y_prob: Sequence[float],
    groups: Sequence[str],
    n_bootstrap: int = 200,
    seed: int = 42,
) -> tuple[float, float]:
    if not y_true or len(y_true) != len(y_prob) or len(y_true) != len(groups):
        raise ValueError("Vetores incompatíveis para bootstrap agrupado")

    by_group: dict[str, list[tuple[int, float]]] = {}
    for yt, yp, g in zip(y_true, y_prob, groups):
        by_group.setdefault(g, []).append((yt, yp))

    group_keys = list(by_group.keys())
    if len(group_keys) < 2:
        val = compute_pr_auc(y_true, y_prob)
        return val, val

    rng = random.Random(seed)
    scores: list[float] = []
    for _ in range(n_bootstrap):
        sampled_keys = [rng.choice(group_keys) for _ in range(len(group_keys))]
        yt_b: list[int] = []
        yp_b: list[float] = []
        for k in sampled_keys:
            for yt, yp in by_group[k]:
                yt_b.append(yt)
                yp_b.append(yp)
        if sum(yt_b) > 0:
            scores.append(compute_pr_auc(yt_b, yp_b))

    if not scores:
        val = compute_pr_auc(y_true, y_prob)
        return val, val

    scores.sort()
    low_idx = max(0, int(math.floor(0.025 * len(scores))))
    high_idx = min(len(scores) - 1, int(math.ceil(0.975 * len(scores))) - 1)
    return round(scores[low_idx], 6), round(scores[high_idx], 6)


def evaluate_shadow_gate(
    candidate: EvaluationMetrics,
    baseline: EvaluationMetrics,
    human_approved: bool,
    min_samples: int = 100,
    min_positives: int = 10,
) -> dict[str, object]:
    if candidate.sample_count < min_samples or candidate.positive_count < min_positives:
        return {
            "decision": "NO-GO",
            "status": "INSUFFICIENT_DATA",
            "shadow_mode": True,
            "reason": f"Amostra insuficiente ({candidate.sample_count}/{min_samples} linhas, {candidate.positive_count}/{min_positives} positivos).",
        }

    beats_pr_auc = candidate.pr_auc > baseline.pr_auc
    beats_brier = candidate.brier_score <= baseline.brier_score

    if not (beats_pr_auc and beats_brier):
        return {
            "decision": "NO-GO",
            "status": "MODEL_NOT_VALIDATED",
            "shadow_mode": True,
            "reason": "Modelo candidato não superou o baseline em PR-AUC e Brier Score simultaneamente.",
        }

    if not human_approved:
        return {
            "decision": "SHADOW_ONLY",
            "status": "MODEL_NOT_VALIDATED",
            "shadow_mode": True,
            "reason": "Métricas técnicas aprovadas no backtest cronológico, mas promoção exige aprovação humana documentada.",
        }

    return {
        "decision": "GO",
        "status": "VALIDATED",
        "shadow_mode": False,
        "reason": "Backtest cronológico aprovado, superou baselines e recebeu aprovação humana.",
    }
