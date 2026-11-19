"""
Motor local de Machine Learning (LightGBM, XGBoost, Regressão Logística, Base Rate e Regras).
Execução local sem dependência de LLM. Modelos só saem de MODEL_NOT_VALIDATED após
backtesting cronológico sem vazamento e aprovação humana do NOC.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    code: str
    horizon_hours: int
    ablation: str  # "Rede" | "Rede+Energia" | "Rede+Energia+Clima"
    shadow_mode: bool = True
    validated: bool = False
