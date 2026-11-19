# Discovery técnico — AIOps Intelligence Platform

**Data:** 18/11/2026\
**Repositório:** https://github.com/victorlaraujo84/AIOps-Intelligence-Platform\
**Branch:** `main`\
**Escopo:** inspeção estática seletiva do código-fonte via GitHub; **não** foram executados build, testes, containers, migrações ou conexões externas.\
**Decisão preliminar:** **NO-GO para produção/predições**, **GO condicional para desenvolvimento e homologação**.

> Registro histórico de inspeção seletiva, sem SHA de origem informado. Não representa automaticamente `fe4df40`: catálogo SLAview, serviços, métricas, logs e correlação multidomínio já têm código parcial nesse commit. Consulte [o registro de importação](IMPORTACAO_DOCUMENTAL_2026-11-19.md). Prioridades e decisões deste documento não substituem uma auditoria atual.

## 1. Resumo executivo

A aplicação já contém backend Express com SQLite, autenticação e RBAC, esquema multi-tenant, cadastro e ingestão de eventos, mecanismos iniciais de geocodificação e clima. Há uma arquitetura de destino em PostgreSQL/PostGIS, Redis e FastAPI. Contudo, a API Python é embrionária, os modelos ML são apenas contratos, e o runtime Web ainda persiste em SQLite isolado do PostgreSQL do Compose. O SLAview não aparece na enumeração de tipos de conectores do schema SQLite examinado. Não foi comprovado funcionamento de integração real do tenant.

**Evidência:** `README.md`, `package.json`, `src/server/{app,db,integrations,security}.ts`, `services/api/app/{main,schemas}.py`, `services/{correlation,feature-engine,ml-engine,ai-agent}/*`, `backtesting/split.py`, `compose.yaml`, `infra/migrations/001_initial_schema.sql`, `docs/{architecture,discovery,implementation-plan}.md`, `.github/workflows/ci.yml`.

## 2. Matriz de maturidade (estática)

| Domínio | Evidência verificada | Estado / lacuna |
|---|---|---|
| Web | `server.ts`, `src/server/app.ts`, React/Vite no `package.json` | Implementação identificada; execução não verificada |
| Sessão/RBAC | Middleware de autenticação, resolução de tenant, cookies, `scrypt`, AES-GCM | Implementado parcialmente; requer testes de autorização por rota e segurança de produção |
| SQLite | `src/server/db.ts` com schema e WAL | Implementação real local |
| PostgreSQL/PostGIS | `infra/migrations/001_initial_schema.sql` com tabelas e RLS descrito | Migração presente; RLS não executada/validada |
| API Python | `services/api/app/main.py`: `/health` e `/api/v1/ml/governance-status` | Esqueleto; sem pipeline operacional demonstrado |
| Eventos | `ingestCanonicalEvents()` com idempotência por tenant | Código identificado; validar volume, identidade e consistência |
| Open-Meteo | Teste HTTP e função de sincronização referenciada | Integração parcialmente implementada; resultado real não testado |
| CEP/geocodificação | BrasilAPI/ViaCEP e Nominatim em `integrations.ts` | Implementado; CEP não equivale a coordenada precisa |
| INMET/CEMADEN/CPTEC | RedeMap contém registros de configuração; destino tem tipos INMET/CEMADEN | Não assumir conectores operacionais; implementar/testar individualmente |
| SLAview | Não presente no CHECK de `connector_type` em `src/server/db.ts` | **Não configurado**; API e tenant pendentes |
| Energia CSV ~3 GB | Requisito de negócio, sem importador massivo confirmado na inspeção | Implementar ingestão streaming, staging e validação |
| RCA | `services/correlation/rca.py` classifica por palavras em tipos de eventos | Heurística inicial; não demonstra causalidade |
| Features temporais | `services/feature-engine/temporal_guard.py` | Guarda básica de timestamps; insuficiente como pipeline completo |
| ML | `services/ml-engine/models.py` define `ModelSpec` | Sem treinamento, inferência, métricas ou calibração demonstrados |
| Backtesting | `backtesting/split.py` valida embargo | Verificação pontual; não há experimento completo demonstrado |
| IA | `services/ai-agent/adapter.py` com política de autorização | Contrato, não execução de agente comprovada |
| CI | `.github/workflows/ci.yml` com Node e `py_compile` | Não substitui testes de integração Python, DB, Docker ou segurança RLS |

## 3. Achados priorizados

### P0 — Arquitetura de dados dividida
`compose.yaml` sobe PostgreSQL/PostGIS, Redis e FastAPI, porém o serviço `web` recebe `SQLITE_DB_PATH=/app/data/aiops.db`. Não há evidência, nos arquivos examinados, de que Express e FastAPI compartilhem o mesmo armazenamento operacional. **Ação:** definir PostgreSQL como fonte única de verdade em produção, com migração transacional, repositórios e contrato de API. Manter SQLite apenas como modo local explicitamente delimitado.

### P0 — Segurança de conectores e rede interna
`validateExternalUrl()` em `src/server/security.ts` bloqueia IPs privados literais e alguns hostnames internos. A verificação visível não resolve DNS nem revalida IPs após resolução ou redirecionamentos. Há risco potencial de DNS rebinding/redirect SSRF, sujeito ao comportamento do cliente HTTP. Além disso, ambientes SLAview corporativos podem usar endereços privados, atualmente bloqueados. **Ação:** conector SLAview por egress dedicado e allowlist administrativa, com DNS/IP pinning, política de redirects, TLS, timeout e auditoria; não liberar indiscriminadamente redes privadas.

### P0 — Segredos e runtime de produção
`security.ts` gera segredos de fallback em `data/.runtime_secrets.json` ou memória quando variáveis não estão configuradas. O Compose monta `/app/data` e configura SQLite, mas não passa explicitamente `AUTH_SESSION_SECRET` e `CREDENTIAL_ENCRYPTION_KEY` ao serviço Web no bloco `environment` examinado. **Ação:** exigir segredos explícitos em produção, armazená-los fora do repositório e testar persistência/rotação. Rever `getClientIp` e `x-forwarded-proto`, que confiam em headers sem configuração de proxy confiável claramente demonstrada no trecho inspecionado.

### P0 — ML ainda não é operacional
`models.py` contém apenas uma dataclass `ModelSpec`, e a API Python retorna `MODEL_NOT_VALIDATED` e `PREDICTION_UNAVAILABLE`. Não foi encontrado pipeline executável de treinamento, inferência, calibração, SHAP ou registro de experimentos nos arquivos analisados. **Ação:** manter Shadow Mode e NO-GO até datasets reais, métricas e aprovação humana.

### P1 — RCA simplificado
`classify_incident_rca()` utiliza palavras como `power`, `weather` e `network` para classificar categorias. Isso não basta para inferir causa raiz, precedência temporal, dependências upstream/downstream, nem evidência energética. **Ação:** correlacionar eventos normalizados por site, ativo, janela temporal e topologia; registrar hipóteses, evidências e incerteza.

### P1 — Ingestão energética de ~3 GB
Não tratar CSV como payload HTTP integral. **Ação:** processo Python por streaming/lotes; detectar encoding/delimitador e esquema real; registrar origem, hash, checkpoints, rejeições, deduplicação e timezone; staging em Parquet/DuckDB ou SQLite indexado conforme benchmark; depois ingestão canônica no PostgreSQL. Não presumir colunas sem amostra.

### P1 — SLAview pendente de tenant
Adicionar `slaview` ao catálogo de conectores e contrato de dados apenas após confirmar produto/versão, URL, autenticação, documentação de Web Services, permissões, rede e exemplos de respostas. Iniciar em `NOT_CONFIGURED`, somente leitura, sem inventar endpoints. Separar importação histórica de coleta incremental.

### P1 — Conectores herdados do RedeMap
`RedeMap/src/services/database.ts` contém configurações para OSM/CartoDB, INMET, Open-Meteo, CEMADEN, CPTEC, Google Maps e BrasilAPI. Esses registros **não comprovam conectividade real**; campos como `lastStatus: ok` e latências predefinidas não devem ser migrados como resultados reais. O `correlationEngine.ts` do RedeMap usa `Math.random()` e mensagens meteorológicas fabricadas. O `csvParser.ts` cria coordenadas, IPs e seriais aleatórios em faltas de dados. **Ação:** aproveitar apenas contratos/configurações úteis, reimplementar coleta verificável, nunca copiar simulações para produção.

### P2 — Observabilidade, resiliência e CI
Criar métricas por conector, logs estruturados com tenant e correlation-id, dead-letter queue, retries com jitter, rate limit distribuído e status `SOURCE_STALE`. Ampliar CI para pytest, integração PostgreSQL/RLS, Docker Compose smoke tests, SAST/dependency scanning e migrações. CI existente apenas compila Python (`py_compile`).

## 4. Plano de execução para Codex

| Fase | Entregável | Critério de aceite |
|---|---|---|
| 0 — Baseline | Inventário completo de arquivos, árvore, dependências, rotas, testes, CI e issues | `npm ci && npm run lint && npm run build && npm test` e `pytest` com resultados registrados; falhas documentadas |
| 1 — Segurança | Secrets obrigatórios, revisão proxy/cookies, SSRF com resolução DNS/redirects, testes de RBAC | Testes negativos e cross-tenant automatizados; nenhuma credencial em logs |
| 2 — Persistência | PostgreSQL como fonte de verdade, migrações, isolamento RLS | Testes reais de duas tenants e super_admin, inclusive consultas diretas |
| 3 — Contratos | Interface `Connector`, estados, auditoria, ingestão idempotente | Fixtures isoladas, esquema validado e reprocessamento sem duplicatas |
| 4 — Fontes reais | Open-Meteo e geocodificação; INMET/CEMADEN/CPTEC somente após verificação | Evidência de chamada real, timestamps, qualidade e falhas explícitas |
| 5 — SLAview | Discovery da API do tenant e conector read-only | Contrato aprovado, teste de conectividade e coleta real auditada |
| 6 — Energia | Conversor CSV 3 GB e processamento incremental | Uso de memória limitado, reconciliação de contagens, benchmarks e retomada |
| 7 — RCA | Correlação por topologia, espaço e tempo | Casos reproduzíveis com evidências; sem alegações causais indevidas |
| 8 — ML | Baselines, LightGBM/XGBoost, split cronológico, embargo, calibração, SHAP | PR-AUC, Brier, recall, lead time, falsos alertas/site/dia, ablações e aprovação humana |
| 9 — Operação | Observabilidade, backup, restauração, runbooks e deploy | Testes de recuperação, incidentes de fonte indisponível e checklist de produção |

## 5. Critérios obrigatórios de qualidade

- Dados reais e verificáveis; fixtures apenas em testes, claramente identificadas.
- Toda evidência possui origem, tenant, timestamps UTC, versão de regra/modelo e qualidade.
- Previsões históricas usam somente informações disponíveis no instante da decisão; arquivar previsão emitida separadamente de observação posterior.
- Falhas de API retornam `NOT_CONFIGURED`, `NO_DATA`, `SOURCE_STALE` ou erro explícito, nunca `ok` fabricado.
- Credenciais não são expostas ao frontend nem persistidas em texto puro.
- Nenhuma modificação de produção sem revisão, testes e aprovação.

## 6. Pendências para aprofundar o Discovery

1. Executar CI e testes locais em ambiente com rede/dependências.
2. Inspecionar **todos** os arquivos, testes, rotas e telas, incluindo diff e histórico de commits.
3. Confirmar se a migração SQL aplica `ENABLE/FORCE ROW LEVEL SECURITY` e políticas a todas as tabelas, e testar com usuários reais de banco.
4. Inspecionar todos os pontos de `fetch`, redirects, autorização por rota, bootstrap de super_admin, upload e importação.
5. Solicitar ao tenant SLAview: versão, URL, método de autenticação, documentação API/Web Services, IP allowlist e amostras anonimizadas.
6. Solicitar cabeçalho e algumas linhas anonimizadas do CSV energético para projetar importador.

## 7. Prompt de execução sugerido ao Codex

> Faça o Discovery técnico integral da branch main do repositório `victorlaraujo84/AIOps-Intelligence-Platform`. Leia `docs/DISCOVERY_TECNICO_AIOPS.md` como baseline de hipóteses, confirme ou refute cada achado com arquivo e linha, execute testes e compile resultados reproduzíveis. Não altere código na fase de auditoria. Crie relatório de arquitetura, matriz de segurança multi-tenant, cobertura dos conectores, inventário de rotas e riscos P0/P1/P2. Não invente dados, integrações ou métricas. Proponha PRs pequenos e verificáveis, priorizando segredos/SSRF, fonte única PostgreSQL, conectores reais, ingestão energética e governança de ML. Preserve SLAview como NOT_CONFIGURED até documentação do tenant.

## 8. Limitações e rastreabilidade

Este relatório foi elaborado por leitura remota seletiva dos arquivos nomeados, não por clone local ou execução. Ausência de implementação *nos arquivos examinados* não prova ausência em todo o repositório. As prioridades são recomendações técnicas e os riscos potenciais exigem confirmação por testes. A documentação `docs/discovery.md` do próprio projeto descreve a Etapa A como parcial e registra dependências externas pendentes.
