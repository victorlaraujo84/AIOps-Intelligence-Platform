# Contratos de Dados Espaço-Temporais

## Evento Canônico (`canonical_events`)

Campos obrigatórios para ingestão idempotente via `POST /api/integrations/connectors/:id/ingest`:

| Campo | Tipo | Regra |
|---|---|---|
| `tenant_id` | UUID | Resolvido exclusivamente da sessão autenticada no servidor (nunca confiado do cliente). |
| `idempotency_key` | string | Chave única por `(tenant_id, idempotency_key)` para deduplicação determinística. |
| `event_time_utc` | ISO-8601 UTC | Instante original do evento normalizado para UTC. |
| `observed_at_utc` | ISO-8601 UTC | Instante da observação física na fonte. |
| `ingested_at_utc` | ISO-8601 UTC | Gerado pelo servidor no momento da gravação. |
| `forecast_issued_at_utc` | ISO-8601 UTC / null | Obrigatório para previsões emitidas (ex.: Open-Meteo); impede leakage temporal. |
| `source` | string | Identificador da origem (`open_meteo`, `zabbix`, `prtg`, `ups_field`, etc.). |
| `event_type` | string | Tipo normalizado (`weather_observation`, `power_outage`, `link_down`, etc.). |
| `status` | string | Estado normalizado (`NORMAL`, `WARNING`, `UP`, `DEGRADED`, `DOWN`, `OUTAGE`). |
| `quality_flag` | enum | `VALID`, `STALE`, `SUSPECT`, `UNVERIFIED_COORDS`. |
