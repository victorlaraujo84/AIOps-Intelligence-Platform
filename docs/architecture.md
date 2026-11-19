# Arquitetura — AIOps Intelligence Platform

## 1. Visão Lógica

- **Frontend (`src/`):** React 19, TypeScript, Tailwind CSS v4, Leaflet (OpenStreetMap / CartoDB Dark Matter / Esri Satélite).
- **Runtime Web / API (`server.ts` + `src/server/`):** Express com sessões HMAC-SHA256 em cookies `httpOnly`, hashing de senhas com `scrypt` + `timingSafeEqual`, criptografia AES-256-GCM para credenciais de conectores, proteção anti-SSRF em URLs externas e persistência relacional em SQLite (para execução imediata em Node/AI Studio) alinhada ao schema PostgreSQL/PostGIS.
- **Serviços Python (`services/` e `backtesting/`):** FastAPI + Pydantic, módulos de ingestão, correlação/RCA, feature engine anti-leakage, treinamento local LightGBM/XGBoost/SHAP e adaptadores opcionais de IA.
- **Persistência Alvo de Produção (`infra/migrations/001_initial_schema.sql`):** PostgreSQL 16 + PostGIS com Row-Level Security (RLS) ativada em todas as tabelas pertencentes a tenants.

## 2. Fronteiras de Segurança

1. Todo usuário não `super_admin` tem `tenant_id` fixo no registro do usuário; qualquer tentativa de sobrescrever `tenant_id` via query string, header `X-Tenant-Id` ou body retorna `403 Forbidden` e grava evento `CROSS_TENANT_ACCESS_DENIED` em `audit_logs`.
2. `super_admin` só alterna de tenant via `POST /api/auth/switch-tenant`, persistido na sessão do servidor e auditado em `SUPER_ADMIN_TENANT_SWITCH`.
3. Conectores configuráveis passam por `validateExternalUrl` bloqueando IPs privados (`10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `::1`, `fc00::/7`), domínios `.local`/`.internal` e esquemas não HTTP(S).
