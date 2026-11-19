# PROMPT MESTRE — AIOps Intelligence Platform

**Versão:** 1.0\
**Projeto:** novo e independente\
**Idioma de interface e documentação:** português do Brasil\
**Fluxo de desenvolvimento:** Google AI Studio → GitHub → Codex + AIOps Validation Skill v3.0 → homologação com dados reais

> **Instrução ao Google AI Studio:** atue como uma equipe sênior de arquitetura, engenharia Full Stack, SRE, segurança multi-tenant, engenharia de dados, ciência de dados e AIOps. Construa um repositório executável, e não apenas uma demonstração visual. Não afirme que algo está implementado sem código funcional, integração verificável e teste. Se a plataforma do AI Studio não permitir executar ou verificar determinada etapa, registre o bloqueio e entregue o código e as instruções para execução posterior no repositório GitHub.

## 1. Objetivo do produto

Criar uma plataforma web Full Stack, multi-tenant, para gestão georreferenciada de sites e ativos, topologia de rede, integração de dados reais de **Rede/Telecom, Energia e Clima**, correlação espaço-temporal, agrupamento de incidentes, análise de causa raiz (RCA), previsão de indisponibilidade e validação rigorosa de modelos de Machine Learning.

O sistema deve servir ao NOC e a equipes de infraestrutura, com trilhas de auditoria e relatórios de eficiência operacional. Os motores **LightGBM e XGBoost devem treinar e inferir localmente**, sem dependência de LLM. A camada de IA generativa será opcional, selecionável entre **OpenAI API, Ollama local e modo offline**.

## 2. Regras inegociáveis

1. **Proibido usar dados operacionais fictícios** em telas, gráficos, mapas, contadores, incidentes, alertas, modelos, previsões ou relatórios. Não gerar seed de demonstração nem retornar arrays estáticos que pareçam telemetria real.
2. É permitido usar **fixtures isoladas exclusivamente em testes automatizados**, claramente identificadas, nunca expostas como produção.
3. Quando não houver dados ou integração configurada, exibir estados honestos: `NOT_CONFIGURED`, `NO_DATA`, `SOURCE_STALE`, `INSUFFICIENT_DATA`, `MODEL_NOT_VALIDATED`, `PREDICTION_UNAVAILABLE`.
4. Toda métrica exibida deve possuir origem rastreável, janela temporal, tenant e status de qualidade.
5. Nenhum botão será decorativo: deve realizar uma ação implementada ou estar desabilitado com justificativa.
6. Não inventar respostas de APIs externas, tokens, disponibilidade de endpoints ou resultados de treinamento.
7. Segurança e isolamento de tenants devem ser impostos **no servidor e no banco**, nunca apenas no frontend.
8. Não enviar dados de clientes para provedores de IA sem configuração e autorização explícitas.
9. Operações preventivas começam em **Shadow Mode**; ações de campo, alteração de produção e promoção de modelos exigem aprovação humana.
10. Não prometer 100% de precisão, disponibilidade ou funcionamento de integrações sem testes. A meta é **100% de requisitos homologados com evidências**, registrando os bloqueios externos.

## 3. Estratégia de implementação por etapas

**Etapa A — Google AI Studio:** gerar aplicação e repositório inicial com UI real, API, autenticação, multi-tenancy, migrações, cadastros, mapas, contratos de dados, conectores configuráveis, logs e estados vazios honestos. Priorizar um fluxo vertical completo e verificável antes de ampliar as telas. Se não puder executar backend Python, fornecer o serviço completo em diretório próprio, Dockerfile e testes para execução local posterior; não substituí-lo por mocks.

**Etapa B — GitHub:** publicar código sem segredos, incluir `.gitignore`, `.env.example`, `README.md`, `compose.yaml`, migrations, documentação de arquitetura, testes, CI e issues para pendências. A publicação será realizada pelo usuário ou por ferramenta explicitamente autorizada; não alegar que o repositório foi publicado sem confirmação.

**Etapa C — Codex + Skill:** após clonar o repositório, instalar a Skill `aiops-validation-v3` em `.agents/skills/aiops-validation-v3/`, executar Discovery e matriz de aderência, desenvolver os módulos de ML/RCA/backtesting e validar com dados reais.

**Etapa D — Homologação:** validar isolamento multi-tenant, conectores reais, topologia, dados históricos, backtesting sem vazamento, inferência, relatórios, backup/restore e operação em Shadow Mode.

Ao final de cada etapa, apresentar arquivos alterados, comandos, testes realmente executados, evidências e limitações. Não marcar itens como concluídos por terem apenas interface ou scaffold.

## 4. Stack e arquitetura alvo

- **Frontend:** Next.js, React, TypeScript, Tailwind CSS; interface dark NOC responsiva e acessível.
- **Backend:** Python 3.11+ com FastAPI, Pydantic e OpenAPI, em serviço independente.
- **Persistência:** PostgreSQL; PostGIS para consultas espaciais; TimescaleDB somente após verificar compatibilidade e justificar o uso. Migrações versionadas com Alembic.
- **Processamento:** Redis e workers assíncronos para ingestão, enriquecimento, correlação e scoring.
- **Cartografia:** Leaflet + OpenStreetMap como padrão, camadas CartoDB Dark Matter/Positron e Esri Satélite quando licenças e políticas permitirem; Google Maps opcional mediante credenciais.
- **ML local:** scikit-learn, LightGBM, XGBoost, SHAP, MLflow para rastreamento de experimentos e artefatos.
- **LLM opcional:** adaptadores separados para OpenAI API e Ollama, com modo offline sem LLM.
- **Observabilidade:** logs estruturados, health/readiness checks, métricas e rastreamento; integração com Prometheus/Grafana quando disponível.
- **Implantação:** Docker Compose com serviços isolados, volumes persistentes, políticas de restart, health checks e segredos fora do repositório.

**Arquitetura lógica:**

```text
apps/web (Next.js)
       |
services/api (FastAPI + RBAC + tenant context)
       |
       +-- asset-topology
       +-- ingestion-workers ---- connectors (Zabbix, PRTG, clima, energia)
       +-- correlation-rca
       +-- feature-engine
       +-- ml-engine (LightGBM / XGBoost / calibração / SHAP)
       +-- ai-agent (OpenAI / Ollama / offline)
       +-- validation-backtesting
       |
PostgreSQL/PostGIS + Redis + MLflow/artifact storage
```

Não impor microserviços desnecessários: módulos podem compartilhar um backend modular inicialmente, mantendo fronteiras claras e workers isolados para tarefas pesadas.

## 5. Segurança, autenticação e multi-tenancy

Papéis:

- `super_admin`: administração global, gestão de tenants, conectores globais, modelos e auditorias; acesso transversal apenas mediante fluxo privilegiado auditado.
- `tenant_admin`: administração do tenant.
- `tenant_operator`: operação, triagem e revisão conforme permissões.
- `tenant_viewer`: leitura restrita ao próprio tenant.

Requisitos:

- Autenticação real, sessões seguras e controle de acesso server-side.
- `tenant_id` obrigatório em entidades pertencentes a tenants, APIs, jobs, cache, datasets, modelos, prompts, artefatos e relatórios.
- PostgreSQL RLS com testes de acesso cruzado e políticas que não dependam de filtros enviados pelo cliente.
- Auditoria de acessos privilegiados e de alternância de tenant.
- Criptografia de segredos em repouso conforme infraestrutura, nunca logar tokens ou dados sensíveis.
- Rate limiting, validação de payloads, proteção contra SSRF em conectores configuráveis, CORS restrito e política de retenção.
- Modelos globais ou compartilhados somente com política explícita de governança, consentimento e validação de isolamento; padrão: treinamento e inferência por tenant.

## 6. Cadastros e mapas

Implementar CRUD real, validação, filtros, paginação e trilha de auditoria para:

- Tenants, usuários, permissões e concessões/unidades de negócio.
- Tipos customizáveis de localidade (`SEDE`, `LOJA`, `ETA`, `ETE`, `ELEVATORIA`, `SUBESTACAO`, `TORRE_RADIO`, `CENTRO_DIST`, outros).
- Sites com nome, código, endereço, CEP, município, UF, latitude, longitude, criticidade e tenant.
- Categorias de ativos (`router`, `switch`, `firewall`, `server`, `radio_link`, `olt`, `access_point`, `ups`, `generator`, etc.).
- Ativos, interfaces, links, provedores, redundâncias e dependências upstream/downstream.

CEP: usar BrasilAPI/ViaCEP para **endereço**, sem presumir que CEP fornece coordenadas exatas. Geocodificação deve utilizar provedor apropriado, indicar precisão e permitir validação manual. Não inventar lat/lon.

Mapa: sites reais do tenant, estados observados, links cadastrados, camadas climáticas e filtros. Quando um site não tiver coordenadas verificadas, exibir pendência cadastral, não um marcador fictício.

Topologia: preferir entidade `topology_edges` (grafo com múltiplos pais/links redundantes) a depender exclusivamente de `topology_parent_id`; manter compatibilidade com esse campo quando necessário. Detectar ciclos inválidos e dependências compartilhadas.

## 7. Central de integrações reais

Criar gestão de conectores com configurações por tenant, teste real de conectividade, autenticação, status, última coleta, atraso, erros, limites, reprocessamento e idempotência.

Conectores prioritários:

- **Rede:** Zabbix, PRTG, traps SNMP, operadoras e webhooks/CSV.
- **Energia:** concessionárias quando houver API autorizada, telemetria UPS/nobreak, geradores, quedas e restabelecimentos.
- **Clima:** Open-Meteo (observações e histórico de previsões emitidas quando disponíveis), INMET, CEMADEN e CPTEC/INPE conforme disponibilidade e condições de uso.

Não afirmar que uma fonte oferece dados ou endpoint específico sem validar a documentação e a resposta real. Ausência de API de concessionária deve ser registrada como bloqueio, permitindo importação autenticada e auditável de dados reais.

Armazenar dados brutos imutáveis quando viável, metadados de ingestão, deduplicação por chave idempotente, histórico de sincronizações e indicadores de cobertura. Implementar retries com backoff, timeout e dead-letter/reprocessamento.

## 8. Contrato de dados espaço-temporal

Campos canônicos mínimos, quando aplicáveis ao tipo de evento:

`tenant_id`, `site_id`, `asset_id`, `event_id`, `event_time_utc`, `observed_at_utc`, `ingested_at_utc`, `forecast_issued_at_utc`, `source`, `event_type`, `status`, `lat`, `lon`, `quality_flag` e referências topológicas.

`forecast_issued_at_utc` é obrigatório para registros de previsão, não para toda observação. Preservar timestamps originais e normalizar a UTC.

Construir joins espaciais por coordenada, distância, estação/região e topologia, com tolerâncias documentadas. Usar H3/PostGIS quando justificado; não associar eventos apenas pelo município quando a precisão for insuficiente.

Features versionadas e auditáveis:

- Clima: `rain_sum_1h`, `rain_sum_3h`, `rain_sum_6h`, `wind_gust_max_1h`, `pressure_delta_3h`, `lightning_count_5km`, `lightning_count_15km` (somente se houver fonte real de raios).
- Energia: `power_outage_active`, `power_outage_elapsed`, `ups_runtime_estimate`, estado de gerador.
- Rede: `link_type`, `site_failure_rate_past`, `upstream_alert_count`, `maintenance_flag`, redundância e degradação.
- Contexto: sazonalidade, criticidade, interações vento×chuva, energia×autonomia e exposição topológica.

Para cada feature registrar definição, unidade, fonte, disponibilidade em `t`, atraso e qualidade. Nunca preencher variáveis ausentes com valores aparentemente reais sem estratégia explícita e indicador de imputação.

## 9. Incidentes e RCA

- Distinguir **evento**, **alarme**, **incidente raiz**, **impacto downstream** e **hipótese de causa**.
- Consolidar alarmes em cascata com base em topologia, precedência temporal, área geográfica e autonomia de UPS.
- Categorias de RCA: `eletrica`, `climatica_direta`, `composta`, `telecom_outros`, `desconhecida`.
- Registrar evidências, confiança, versão das regras e revisão humana.
- Não tratar Granger/Hawkes, precedência ou SHAP como prova de causalidade.
- Criar linha do tempo por incidente e mecanismos de confirmação/correção do RCA por operadores autorizados.

## 10. Predição local e laboratório de modelos

Prever **indisponibilidade futura** separadamente da classificação de causa raiz, com horizontes `H = 1h, 3h, 6h` e frequência de scoring configurável.

Implementar e comparar:

A. Base rate/prevalência por tenant/região;\
B. Regras operacionais;\
C. Regressão logística;\
D. LightGBM;\
E. XGBoost.

Ablações com os mesmos splits: `Rede`, `Rede + Energia`, `Rede + Energia + Clima`.

Treinar com séries históricas reais e dados **disponíveis no instante de decisão**: observações com `ingested_at_utc <= t` e previsões históricas com `forecast_issued_at_utc <= t`. Não utilizar clima futuro observado para simular previsão passada.

Usar splits cronológicos, embargo compatível com lookback/horizonte, validação separada, calibração em período próprio e holdout final intocado. Avaliar generalização em sites/regiões não vistos quando houver dados suficientes. Reamostragem/pesos somente no treino; manter prevalência real na validação/teste.

Métricas obrigatórias: PR-AUC e prevalência, precision, recall, F1/F-beta, Brier Score, curva de calibração, Precision@K, falsos alertas por site/dia, antecedência útil mediana, cobertura por tenant/região e tempestade vs. operação normal. Incerteza com bootstrap agrupado por site/incidente/bloco temporal.

Registrar versões de datasets, features, código, parâmetros, sementes, períodos, métricas, artefatos, tempos e custos. SHAP deve ser apresentado como contribuição ao score, **não causalidade nem porcentagem direta de risco**.

Exibir previsões apenas de modelos aprovados; se ainda não houver modelo validado, mostrar `MODEL_NOT_VALIDATED` e disponibilizar o laboratório de treinamento.

## 11. Agente de IA híbrido

Criar interfaces de provedores para `offline`, `openai` e `ollama`, com configurações administrativas, timeouts, políticas de dados, logs e limites de acesso.

O agente pode:

- Revisar relatórios de backtesting e qualidade de dados.
- Sugerir novas features, verificando disponibilidade temporal.
- Investigar falsos positivos/negativos e propor experimentos controlados.
- Resumir hipóteses RCA com citações a eventos internos e evidências.
- Gerar recomendações operacionais para revisão humana.

O agente **não pode** inventar probabilidades, executar comandos arbitrários, alterar dados brutos, promover modelos ou acionar equipes sem aprovação. Propostas devem ser estruturadas, auditadas e avaliadas por pipeline determinístico. Falha de LLM não pode interromper ingestão, RCA determinístico ou scoring local.

## 12. Telas e experiência do usuário

Criar interface NOC escura, alta legibilidade, com navegação real para:

1. Visão geral NOC: disponibilidade, incidentes, integridade das fontes, alertas e riscos validados.
2. Mapa operacional: sites, ativos, enlaces, filtros por tenant/concessão e clima.
3. Gestão de tenants, usuários e RBAC.
4. Cadastros de concessões, sites, categorias, ativos e topologia.
5. Central de integrações e histórico de sincronização.
6. Timeline de eventos, incidentes e RCA.
7. Laboratório de ML, experimentos e versões.
8. Backtesting, ablações, calibração e métricas.
9. Previsões, SHAP e Shadow Mode.
10. Relatórios, auditoria e configurações de IA.

O `super_admin` poderá selecionar tenant com auditoria; demais papéis só visualizam seu próprio tenant. Componentes sem dados reais exibem estados vazios explicativos e ações de configuração. Nunca renderizar gráficos com números de exemplo em modo operacional.

## 13. Relatórios e governança

Gerar `discovery.md` e `validation-report.md`, além de relatórios exportáveis com filtros por tenant. Relatório de validação deve conter fontes, cobertura, qualidade, hipóteses, metodologia, splits, comparativos com intervalos de confiança, leakage checks, latência/custo, erros e decisão `GO`, `CONDITIONAL` ou `NO-GO` baseada em critérios acordados previamente com o NOC.

Modelos iniciam em Shadow Mode. Promover para uso assistido somente após aprovação e critérios operacionais atingidos. Registrar decisões, autor, data e evidências.

## 14. Estrutura mínima do repositório

```text
aiops-intelligence-platform/
├── apps/
│   └── web/
├── services/
│   ├── api/
│   ├── ingestion/
│   ├── correlation/
│   ├── feature-engine/
│   ├── ml-engine/
│   └── ai-agent/
├── backtesting/
├── infra/
│   ├── docker/
│   └── migrations/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── security/
│   └── acceptance/
├── docs/
│   ├── architecture.md
│   ├── discovery.md
│   ├── implementation-plan.md
│   ├── data-contracts.md
│   ├── validation-report.md
│   └── deployment.md
├── .agents/
│   └── skills/                # adicionar Skill v3.0 no Codex, posteriormente
├── .github/workflows/
├── .env.example
├── .gitignore
├── compose.yaml
└── README.md
```

Não incluir credenciais nem dados reais sensíveis no Git. Criar exemplos de configuração com placeholders claramente não operacionais.

## 15. Testes e critérios de aceite

Criar testes unitários, integração, contratos, RBAC/RLS, acesso cruzado entre tenants, conectores, idempotência, timestamps, joins espaciais, topologia, RCA, anti-leakage, backtesting, calibração, endpoints, interface e exportação. Criar pipeline CI para lint, typecheck, testes e verificações de segurança.

Homologar por evidências:

- Usuário autenticado só acessa dados autorizados.
- CRUD persiste e consulta dados reais.
- Conectores exibem sucesso/erro real e persistem eventos idempotentemente.
- Mapa mostra apenas sites com coordenadas verificadas.
- Incidentes correlacionados possuem rastreabilidade até eventos brutos.
- Backtesting reproduz resultados com o mesmo dataset/configuração.
- Modelos locais treinam, são calibrados e geram inferência com versão.
- Falta de dados não gera risco inventado.
- Relatórios são exportáveis e isolados por tenant.
- Backup/restore e recuperação de falhas são documentados e testados em ambiente apropriado.

Cada requisito deve ter identificador, implementação, teste, evidência e status `PASS`, `FAIL`, `BLOCKED` ou `NOT_TESTED`. Não declarar "100% operacional" enquanto houver itens críticos sem homologação.

## 16. Instruções de execução imediata no Google AI Studio

**Comece pela primeira entrega vertical funcional**, nesta ordem:

1. Crie a estrutura de projeto, `README.md`, `.env.example`, `compose.yaml` e documentação de arquitetura.
2. Implemente autenticação, RBAC e persistência multi-tenant reais.
3. Implemente CRUD de tenants (administrador), concessões, sites e ativos, com API e formulários funcionais.
4. Implemente mapa com sites realmente cadastrados e estados vazios corretos.
5. Implemente Central de Integrações com contratos e persistência; conecte uma fonte real apenas quando houver credenciais/configuração verificáveis.
6. Implemente testes e documente exatamente o que foi ou não executado.
7. Liste pendências de energia, clima, Zabbix/PRTG e ML que dependem de fontes e infraestrutura reais.
8. Prepare o repositório para exportação ao GitHub e posterior trabalho no Codex.

**Não interrompa o desenvolvimento para fabricar demonstrações.** Se faltar credencial, implemente o fluxo de configuração e mostre `NOT_CONFIGURED`. Se uma tecnologia não puder ser executada no ambiente do AI Studio, gere os arquivos corretos, explique como testar localmente e marque `NOT_TESTED`, sem alegar funcionamento.

## 17. Formato obrigatório de resposta a cada entrega

Apresente:

- **Entregue:** funcionalidades efetivamente implementadas e arquivos.
- **Testado:** comandos e resultados observados.
- **Pendente:** dependências, bloqueios e riscos.
- **Próximo incremento:** menor conjunto de tarefas que entrega valor operacional verificável.
- **Comandos de execução:** passos exatos para rodar localmente e preparar GitHub.

**Inicie agora a Etapa A e entregue o primeiro incremento vertical funcional.**
