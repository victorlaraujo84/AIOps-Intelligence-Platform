# Contratos de Dados Canônicos (Fase 1 a Fase 5)

Todos os registros são isolados por `tenant_id` derivado exclusivamente da sessão autenticada e carregam timestamps em **UTC ISO-8601**.

## 1. Ativos Universais (`assets`)
- `site_id`: `UUID | null` (opcional para ativos lógicos de TI/Cloud/IoT).
- `domain`: string extensível (`ti`, `rede`, `iot`, `energia`, `ambiente`, `infra`, ou customizado).
- `georeference_mode`: `'required' | 'optional' | 'none'`.
- `asset_type_code`: código extensível da taxonomia do tenant.
- `metadata_json`: metadados específicos por domínio sem alterar esquema.

## 2. Serviços e Dependências (`services`, `service_dependencies`)
- `services`: `id`, `tenant_id`, `code`, `name`, `domain`, `criticality`, `owner_team`, `sla_target_pct`, `operational_state`.
- `service_dependencies`: vincula um serviço a um `asset_id` ou a um `upstream_service_id`, com `dependency_role` (`primary | redundant | supporting`) e bloqueio de ciclos no servidor (`wouldCreateServiceCycle`).

## 3. Métricas Numéricas (`metric_samples`)
- `tenant_id`, `asset_id?`, `service_id?`, `site_id?`, `connector_id?`
- `idempotency_key` (único por tenant)
- `metric_name`, `value_num`, `unit`
- `observed_at_utc`, `ingested_at_utc`, `source`, `quality_flag`, `tags_json`

## 4. Logs Operacionais (`operational_logs`)
- `tenant_id`, `asset_id?`, `service_id?`, `site_id?`
- `idempotency_key` (único por tenant)
- `severity` (`DEBUG | INFO | WARN | ERROR | FATAL`), `message`, `trace_id?`
- `observed_at_utc`, `ingested_at_utc`, `source`, `attributes_json`

## 5. Eventos Canônicos (`canonical_events`)
- `tenant_id`, `site_id?`, `asset_id?`, `idempotency_key`
- `event_time_utc`, `observed_at_utc`, `ingested_at_utc`, `forecast_issued_at_utc?` (obrigatório para previsões)
- `source`, `event_type`, `status`, `lat?`, `lon?`, `quality_flag`

## 6. Escopos Autorizados de Coleta (`authorized_collection_scopes`) e Checkpoints (`ingestion_checkpoints`)
- `authorized_collection_scopes`: `protocol` (`snmp_v3 | mqtt | icmp | otlp | http_agent`), `target_cidr_or_host` (proibido `*`), `port?`, `rate_limit_rpm`, `is_active`, `approved_by`.
- `ingestion_checkpoints`: `connector_id`, `cursor_key`, `cursor_value`, `rows_processed`, `bytes_processed`, `status` (`IN_PROGRESS | COMPLETED | FAILED`).
