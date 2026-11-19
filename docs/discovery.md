# Discovery — Etapa A (Google AI Studio)

**Status:** Parcial (Etapa A concluída; Etapa C/D aguardam infraestrutura Python completa e fontes reais do cliente).

## 1. Ambiente Verificado na Etapa A

- **Node.js:** v22.23.2 (execução ativa do servidor Express + Vite + React na porta 3000).
- **Python:** 3.11.2 disponível no ambiente base; pacotes pesados de ML (`lightgbm`, `xgboost`, `shap`) e banco PostgreSQL/PostGIS/Redis declarados em `services/api/requirements.txt` e `compose.yaml` para execução em container/ambiente local.
- **Persistência executada no preview:** SQLite (`better-sqlite3`) com schema relacional multi-tenant espelhando as tabelas da migração `001_initial_schema.sql`.

## 2. Bloqueios e Dependências Externas Registrados

| Domínio | Status | Bloqueio / Dependência Externa |
|---|---|---|
| Zabbix / PRTG / SNMP | `NOT_CONFIGURED` | Exige URL, token/credencial e conectividade de rede com instância real do cliente. |
| Energia (Concessionárias / UPS) | `NOT_CONFIGURED` | Ausência de API pública unificada de concessionárias; suportado via conector autenticável ou ingestão JSON/CSV auditável. |
| Clima (Open-Meteo) | `CONFIGURABLE` | API pública real pronta para teste/sincronização por site com coordenadas verificadas; INMET/CEMADEN aguardam definição de estações/credenciais. |
| PostgreSQL + PostGIS + RLS | `NOT_TESTED` (em runtime) | SQL com políticas RLS criado em `infra/migrations/001_initial_schema.sql`; execução requer Docker Compose com serviço `postgres`. |
| LightGBM / XGBoost / Backtesting | `MODEL_NOT_VALIDATED` | Módulos Python estruturados em `services/ml-engine` e `backtesting/`; treinamento real requer série histórica mínima ingestada. |
