# Relatório de Validação e Critérios GO / NO-GO

## 1. Governança de Modelos Preditivos
- **Status Atual:** `MODEL_NOT_VALIDATED` / `PREDICTION_UNAVAILABLE`
- **Decisão Atual de Produção:** **NO-GO (Shadow Mode obrigatório)**
- **Motivo Objetivo:** Nenhum tenant possui ainda série histórica real rotulada e backtest cronológico aprovado com revisão humana formal documentada.

## 2. Critérios Obrigatórios para Promoção (GO)
1. **Integridade Temporal Anti-Leakage:** Todas as features validadas com `ingested_at_utc <= t` e `forecast_issued_at_utc <= t` (`services/feature-engine/temporal_guard.py`).
2. **Split Cronológico com Embargo:** Separação treino/validação/holdout sem mistura temporal (`backtesting/split.py`).
3. **Superação de Baselines:** Modelo candidato (Regressão Logística / LightGBM / XGBoost) deve superar simultaneamente Base Rate (A) e Regras Determinísticas (B) em PR-AUC e Brier Score com intervalo de confiança via bootstrap agrupado (`backtesting/evaluator.py`).
4. **Aprovação Humana Auditada:** Registro explícito de revisão pelo líder de NOC antes de desativar Shadow Mode.

## 3. Runbook de Homologação e Operação (Fase 6)
- **Backup SQLite Automático:** Antes de aplicar qualquer versão em `src/server/migrations.ts`, o sistema grava snapshot automático em `data/backups/aiops-pre-v<N>-<timestamp>.db`.
- **Backup PostgreSQL (Produção):** Executar `pg_dump -Fc` antes de aplicar `infra/migrations/*.sql`.
- **Monitoramento de Coletores:** Verificar `connector_sync_runs` e `ingestion_checkpoints` quanto a falhas ou estado `SOURCE_STALE`.
