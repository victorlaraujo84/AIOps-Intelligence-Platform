# Guia de Implantação e Operação

## 1. Segredos Obrigatórios em Produção
Antes de iniciar em produção, defina no `.env` (nunca commitar `.env` no Git):
- `AUTH_SESSION_SECRET`: string aleatória de 64+ caracteres hex.
- `CREDENTIAL_ENCRYPTION_KEY`: chave de 32+ bytes para AES-256-GCM.
- `POSTGRES_PASSWORD` e `DATABASE_URL`.

## 2. Backup e Restore (SQLite local e PostgreSQL)
- **SQLite (`data/aiops.db`):** utilizar `sqlite3 data/aiops.db ".backup 'backup.db'"` com WAL consolidado.
- **PostgreSQL (`compose.yaml`):** `pg_dump -Fc -U aiops aiops_platform > backup.dump` e `pg_restore -d aiops_platform backup.dump`.
- O procedimento deve ser validado com restauração periódica em ambiente de homologação (Etapa D).
