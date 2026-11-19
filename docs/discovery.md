# Discovery & Matriz de Aderência — Evolução Híbrida (E01–E07)

## E01 — Evidências Reais no Código
- **Frontend (`src/components/`):** `NocOverviewView.tsx`, `InventoryTopologyView.tsx`, `OperationalMapView.tsx`, `IntegrationsView.tsx`, `IncidentsRcaView.tsx`, `MlGovernanceView.tsx`, `ReportsAuditAiView.tsx`, `TenantsRbacView.tsx`.
- **Backend (`src/server/`):** `app.ts` (Express + Auth + RBAC + APIs híbridas), `db.ts` + `migrations.ts` (SQLite WAL + migração v2 com backup), `collection.ts` (validação CIDR/host), `correlation.ts` (RCA multidomínio + Z-Score), `integrations.ts` (Open-Meteo, catálogo, checkpoints CSV), `topology.ts` (prevenção de ciclos em ativos e serviços), `security.ts` (`scrypt`, AES-256-GCM, anti-SSRF).
- **Persistência alvo (`infra/migrations/`):** `001_init_postgres.sql` e `002_hybrid_observability.sql` (particionamento mensal + RLS).
- **Serviços Python (`services/`, `backtesting/`):** `schemas.py`, `native_collectors.py`, `temporal_guard.py`, `rca.py`, `split.py`, `evaluator.py`, `train_and_evaluate.py`.

## E02 — Matriz de Aderência
| Capacidade | Estado | Observação Honesta |
|---|---|---|
| Multi-tenancy, Auth `scrypt` + RBAC + Auditoria | Implementado e Testado | Sessão híbrida (cookie + Bearer) funcional em iframe |
| Ativos sem site obrigatório e Domínios extensíveis | Implementado e Testado | Migração v2 preserva ativos existentes |
| Catálogo de Serviços e Dependências sem ciclos | Implementado e Testado | Integrado ao cálculo de impacto em incidentes |
| Métricas, Logs, Eventos e Anomalias separados | Implementado e Testado | Z-Score exige `>= 5` amostras prévias |
| CSV Incremental com Checkpoints | Implementado e Testado | Retomada a partir de `rows_processed` |
| Coleta Nativa Autorizada (`authorized_collection_scopes`) | Implementado (Receptor + Guard) | Bloqueia alvos fora de escopo (`403`); workers SNMP/MQTT/ICMP externos em `services/ingestion` |
| Telcomanager SLAview | `NOT_CONFIGURED` | Pendente de documentação oficial, URL, versão e autenticação |
| PostgreSQL/PostGIS + FastAPI + LightGBM/XGBoost em runtime | Implementado em código / `NOT_TESTED` em runtime | Sandbox não possui `docker`, `psql`, `fastapi`, `lightgbm`, `xgboost` ou `shap` |

## E05 — Análise de Segurança
- **Anti-SSRF:** `validateExternalUrl` bloqueia `localhost`, IPs privados e metadata endpoints em conectores HTTP.
- **Anti-Varredura:** Coleta nativa e OTLP bloqueadas por padrão (`403`) salvo cadastro prévio de CIDR/host específico em `authorized_collection_scopes`. Curinga `*` rejeitado (`400`).
- **Isolamento:** `tenant_id` sempre extraído da sessão autenticada; tentativas cross-tenant registradas em `audit_logs`.

## E07 — Limitações do Ambiente AI Studio
- Ausência de Docker daemon, PostgreSQL/PostGIS em execução, e bibliotecas Python de ML (`lightgbm`, `xgboost`, `shap`, `scikit-learn`, `fastapi`).
- Todos os testes TypeScript (`tsx --test`) e Python stdlib (`unittest`) são executados diretamente no sandbox; componentes dependentes de infraestrutura externa permanecem explicitamente marcados como `NOT_TESTED` em runtime.
