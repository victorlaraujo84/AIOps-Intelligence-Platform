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

Use Node 22 (versão indicada em `.nvmrc`, mínimo 22.12) e npm 10 ou superior.
O gerenciador deste repositório é npm; `package-lock.json` define a resolução das dependências.
`.npmrc` desativa scripts automáticos de instalação. O better-sqlite3 13 distribui binários prontos;
isso evita a compilação implícita indevida do npm. A verificação abaixo abre e consulta SQLite em memória.

```bash
cp .env.example .env
npm ci --no-audit --no-fund
npm run check:sqlite
npm run dev
```

Acesse `http://localhost:3000`. Como o banco inicia sem usuários fictícios, crie o primeiro `super_admin` na tela de inicialização segura.

## Execução com Docker Compose

Em uma instalação nova, use Docker Engine com Compose v2 e OpenSSL. Os comandos abaixo iniciam o console Web com SQLite persistente e um proxy HTTPS acessível pelo próprio host.

```bash
sh scripts/init-docker-env.sh
docker compose up -d --build --wait
docker compose ps
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./aiops-local-ca.crt
curl --cacert ./aiops-local-ca.crt https://localhost/api/health
```

Confie na CA local para acessar `https://localhost` no navegador e conclua a criação do primeiro administrador com o valor de `AIOPS_BOOTSTRAP_TOKEN` do `.env`. Para atualização de uma base existente, acesso remoto, backup e perfil opcional PostgreSQL/Redis/FastAPI, consulte o [guia de implantação](docs/deployment.md).

## Testes Automatizados

```bash
npm run check:sqlite
npm run lint
npm run build
npm test
python -B -m unittest discover -s tests/unit -p "test_python_*.py" -v
```

Os contratos Python usam a biblioteca padrão; não exigem instalar o runtime ML.
O CI os executa em Python 3.11 e 3.12. O comando `lint` executa a verificação de tipos (`tsc --noEmit`).
Fixtures são exclusivas dos testes; aprovação de testes locais não homologa conectores, PostgreSQL/RLS ou implantação Docker.

Para servir o bundle pelo modo de produção, execute `npm run build` e use o Compose com HTTPS e os segredos configurados.
O histórico e os limites do primeiro incremento P0 estão em [PR_P0_01_REPRODUTIBILIDADE.md](docs/PR_P0_01_REPRODUTIBILIDADE.md).
