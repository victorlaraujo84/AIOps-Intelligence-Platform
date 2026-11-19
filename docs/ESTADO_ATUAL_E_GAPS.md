# Estado atual do repositório e lacunas (inspeção estática anterior)

**Base de evidência:** arquivos do GitHub `victorlaraujo84/AIOps-Intelligence-Platform` inspecionados em 18–19/11/2026. **Não foram executados testes nem deploy nesta revisão.** Codex deve reconfirmar commit, arquivos e resultados.

| Área | Evidência de código | Situação e lacuna |
|---|---|---|
| Web | `server.ts`, `src/server/app.ts` | Express/Vite/React, API com autenticação e CRUD; necessita testes end-to-end de produção |
| Banco web | `src/server/db.ts` | SQLite `better-sqlite3`, WAL; no commit `fe4df40`, domínio e tipo de conector são extensíveis; migração v2 presente, sem homologação de produção |
| Banco alvo | `infra/migrations/001_initial_schema.sql` | PostgreSQL/PostGIS e RLS definidos; execução e equivalência com Web não comprovadas |
| Compose | `compose.yaml` | PostgreSQL, Redis, API FastAPI e Web; Web usa volume SQLite distinto; 5432/6379 publicados no host; senhas placeholder |
| FastAPI | `services/api/app/main.py` | `/health` e governança ML NO-GO; não é backend completo equivalente ao Express |
| Integrações | `src/server/integrations.ts` | BrasilAPI/ViaCEP, Nominatim, teste Open-Meteo, ingestão canônica; `webhook_csv` reporta receptor local, não prova conexão externa |
| Eventos | `canonical_events`/`incidents` em `db.ts` | Deduplicação e RCA determinística; no commit `fe4df40`, métricas, logs, serviços/dependências e correlação multidomínio possuem implementação parcial; traces e operação ponta a ponta não foram comprovados |
| RCA | `services/correlation/rca.py` | Classificador inicial por palavras-chave; não é RCA causal/robusta |
| ML | `services/ml-engine/models.py`, `backtesting/split.py` | Especificações e guardas iniciais; sem evidência de treinamento/calibração/produção |
| Segurança | `src/server/security.ts` | Criptografia, hash e validação de URL; revisar DNS/rebinding/redirects, segredos, rate limit distribuído e RLS efetivo |
| CI | `.github/workflows/ci.yml` | Node lint/build/test; Python só py_compile seletivo; faltam testes Python, DB, Docker e integração reais |

## Atualização de integração documental — 19/11/2026

As duas linhas acima foram reconciliadas com `fe4df40`. O restante preserva a inspeção histórica e deve ser revalidado; consulte [o registro de importação](IMPORTACAO_DOCUMENTAL_2026-11-19.md). Presença de código não significa funcionamento homologado.

## P0 a confirmar no Discovery
1. Fonte única de verdade e migração SQLite → PostgreSQL sem perda de dados.
2. Isolamento tenant completo em HTTP, workers, RLS, cache e ingestão.
3. Credenciais/segredos, acesso a endpoints privados e SSRF seguro para coletores autorizados.
4. Compose seguro: portas de DB/Redis internas, secrets sem defaults fracos, health/readiness e volumes.
5. Compatibilidade de contratos/API, migrações e rollback.

## Não declarar concluído sem prova
SLAview, MQTT, SNMP, OTLP, coleta nativa, TimescaleDB, correlação avançada, predição LightGBM/XGBoost, 3 GB CSV, observabilidade de produção e disaster recovery.
