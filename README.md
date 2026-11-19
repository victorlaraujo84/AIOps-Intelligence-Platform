# AIOps Intelligence Platform

Plataforma web Full Stack, multi-tenant, para gestão georreferenciada de sites e ativos, topologia de rede (`topology_edges`), integração de dados reais de **Rede/Telecom, Energia e Clima**, correlação espaço-temporal, análise de causa raiz (RCA), previsão de indisponibilidade e validação rigorosa de modelos locais (LightGBM / XGBoost).

## Princípios de Engenharia e Governança

1. **Zero dados operacionais fictícios:** telas, gráficos, mapas e relatórios exibem apenas dados persistidos ou estados honestos (`NOT_CONFIGURED`, `NO_DATA`, `SOURCE_STALE`, `INSUFFICIENT_DATA`, `MODEL_NOT_VALIDATED`, `PREDICTION_UNAVAILABLE`).
2. **Isolamento multi-tenant no servidor e no banco:** nenhuma rota aceita `tenant_id` arbitrário enviado por usuários vinculados a um tenant; políticas PostgreSQL RLS estão definidas em `infra/migrations/001_initial_schema.sql`.
3. **Shadow Mode obrigatório:** previsões só são publicadas após backtesting cronológico anti-leakage, calibração e aprovação humana do NOC.
4. **IA Generativa Opcional:** padrão `offline`; provedores `openai` e `ollama` exigem configuração e autorização explícita (`data_sharing_authorized`).

## Estrutura do Repositório

```text
├── server.ts                  # API Express + Vite/React (runtime web porta 3000)
├── src/                       # Frontend React + TypeScript + Tailwind + Leaflet e camada API/DB
├── services/
│   ├── api/                   # Serviço Python 3.11+ FastAPI + contratos Pydantic
│   ├── ingestion/             # Contratos de conectores reais (Rede, Energia, Clima)
│   ├── correlation/           # Correlação e classificação RCA determinística
│   ├── feature-engine/        # Guardas temporais anti-leakage
│   ├── ml-engine/             # Especificação LightGBM / XGBoost / SHAP local
│   └── ai-agent/              # Adaptadores OpenAI / Ollama / Offline
├── backtesting/               # Splits cronológicos com embargo
├── infra/
│   ├── docker/                # Dockerfiles web e api
│   └── migrations/            # SQL PostgreSQL + PostGIS + RLS
├── tests/                     # Testes unitários, segurança multi-tenant e integração
├── docs/                      # Arquitetura, discovery, contratos, plano e validação
└── .github/workflows/ci.yml   # Pipeline de CI
```

## Execução Local (Web + SQLite)

```bash
cp .env.example .env
npm install
npm run dev
```

Acesse `http://localhost:3000`. Como o banco inicia sem usuários fictícios, crie o primeiro `super_admin` na tela de inicialização segura.

## Execução com Docker Compose (PostgreSQL/PostGIS + Redis + FastAPI + Web)

```bash
cp .env.example .env
# Edite .env definindo AUTH_SESSION_SECRET, CREDENTIAL_ENCRYPTION_KEY e POSTGRES_PASSWORD
docker compose up --build
```

## Testes Automatizados

```bash
npm run lint
npm run build
npm test
```
