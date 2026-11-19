# Contexto consolidado — AIOps Intelligence Platform

**Atualizado em:** 19/11/2026\
**Repositório principal:** https://github.com/victorlaraujo84/AIOps-Intelligence-Platform\
**Repositório de referência de conectores:** https://github.com/victorlaraujo84/RedeMap

## Decisão de evolução aprovada em 19/11/2026
**Arquitetura híbrida:** a plataforma atenderá observabilidade operacional de TI e IoT, além de redes/telecom, energia e clima. Dois modos de ingestão: integrações com monitoramentos existentes e coleta nativa progressiva. Prioridade: inteligência sobre ferramentas existentes antes de expandir coletores. O escopo anterior permanece como caso de uso inicial, não como limite da plataforma. Documentos normativos de visão-alvo: `docs/VISAO_PRODUTO_HIBRIDA.md`, `docs/ARQUITETURA_HIBRIDA.md`, `docs/ROADMAP_TECNICO_HIBRIDO.md`.

## 1. Visão e escopo
Projeto independente para equipes NOC/infraestrutura: inventário de sites e ativos, mapas e topologia de rede, integração de eventos reais de Rede/Telecom, Energia e Clima, correlação espaço-temporal, análise de causa raiz e previsões de indisponibilidade com governança e auditoria. Não confundir ou fundir com NOC Intelligence Hub, OperaDash, Zabbix-Analyzer ou Triggers Factory.

## 2. Decisões já estabelecidas
- Interface e documentação em português do Brasil.
- Multi-tenancy real, RBAC e isolamento server-side e no banco, com PostgreSQL RLS para produção.
- Frontend React/TypeScript; runtime atual Express/SQLite; arquitetura de destino PostgreSQL/PostGIS + Redis + FastAPI/Python + Docker.
- ML local (LightGBM/XGBoost e baselines), sem dependência obrigatória de LLM. IA generativa opcional em modos offline, OpenAI ou Ollama, mediante autorização para compartilhamento.
- Previsões para horizontes de 1, 3 e 6 horas são objetivos de produto, não capacidades já validadas.
- Shadow Mode, backtesting cronológico com embargo, anti-leakage, calibração e aprovação humana antes de publicar previsões ou ações.
- Nenhum dado operacional fictício nas telas ou relatórios. Usar estados honestos para dados ausentes.

## 3. Fontes de dados e integrações
### Rede / Telecom
**SLAview (Telcomanager)** é a integração desejada. Escopo inicial somente leitura. Ainda faltam URL/base path do tenant, versão, documentação de API, autenticação, permissões e exemplos reais. Não inventar endpoints. Zabbix/PRTG/SNMP aparecem como opções arquiteturais do código, mas não substituem SLAview.

### Energia
Existe um histórico real de eventos energéticos de 2026 em CSV, com tamanho aproximado de **3 GB**. O layout/cabeçalho e amostras ainda precisam ser fornecidos. Projetar importação em chunks/streaming, validação, checkpoints, idempotência, timezone e rastreabilidade; nunca presumir o esquema do arquivo.

### Clima
Priorizar Open-Meteo e avaliar INMET, CEMADEN e CPTEC/INPE conforme disponibilidade e contratos reais. Preservar `event_time_utc`, `observed_at_utc`, `ingested_at_utc` e, para previsões, `forecast_issued_at_utc`. Não usar informações futuras na decisão passada.

### Geografia
Mapas OpenStreetMap/CartoDB; geocodificação e CEP via Nominatim/BrasilAPI/ViaCEP. Coordenadas de sites devem ter precisão e origem rastreáveis, com verificação humana quando necessário. O RedeMap contém definições de conectores reaproveitáveis, mas também lógicas simuladas que não podem migrar para produção.

## 4. Estado do repositório na inspeção estática de 18/11/2026
Arquivos efetivamente consultados: `README.md`, `package.json`, `server.ts`, `src/server/app.ts`, `src/server/db.ts`, `src/server/integrations.ts`, `src/server/security.ts`, `services/api/app/main.py`, `services/api/app/schemas.py`, `services/correlation/rca.py`, `services/feature-engine/temporal_guard.py`, `services/ml-engine/models.py`, `services/ai-agent/adapter.py`, `backtesting/split.py`, `compose.yaml`, `infra/migrations/001_initial_schema.sql`, `.github/workflows/ci.yml`, `docs/architecture.md`, `docs/discovery.md` e `docs/implementation-plan.md`.

**Achados:** aplicação web com implementação real em Express/SQLite; schema PostgreSQL/PostGIS com RLS declarado; FastAPI com endpoints básicos; RCA determinístico simplificado; ML descrito por contratos; Docker Compose executa Web em SQLite enquanto PostgreSQL atende a stack Python. O conector SLAview não estava presente na enumeração SQLite examinada. Inspeção estática seletiva: **não** houve execução de testes, containers ou chamadas reais aos provedores.

## 5. Riscos e prioridades
- **P0:** definir fonte única de verdade operacional em produção; verificar RLS, isolamento entre tenants, segredos, anti-SSRF e segurança dos conectores; manter previsões indisponíveis até validação.
- **P1:** implementar SLAview read-only após receber informações do tenant; importar CSV real com eficiência; testar fontes climáticas; ampliar correlação e RCA com evidências.
- **P2:** observabilidade, testes de carga, documentação operacional, CI e dashboards de qualidade de dados.

## 6. Documentos de referência
- `docs/DISCOVERY_TECNICO_AIOPS.md`: inspeção técnica e plano de trabalho.
- `docs/REDEMAP_CONECTORES_CONFIGURACAO_AIOPS.md`: inventário dos conectores extraídos do RedeMap, limitações e contrato proposto.
- `docs/PROMPT_MESTRE_AIOPS_INTELLIGENCE_PLATFORM.md`: requisitos originais de produto e regras de engenharia; propostas ainda não equivalem a implementação.
- `AGENTS.md`: instruções permanentes ao Codex.

## 7. Tarefa de entrada para Codex
1. Ler os documentos acima e confrontar as alegações com o código atual.
2. Executar Discovery completo, testes e análise de segurança conforme o ambiente permitir, documentando evidências e bloqueios.
3. Produzir plano incremental de PRs com critérios de aceite, sem alterar código na primeira rodada.
4. Solicitar aprovação antes de iniciar mudanças arquiteturais ou integrar credenciais e dados reais.
