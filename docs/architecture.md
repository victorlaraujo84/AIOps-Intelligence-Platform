# Arquitetura Alvo Híbrida — AIOps Intelligence Platform

## 1. Visão Geral (Observabilidade Universal Multidomínio)
A plataforma evoluiu de monitoramento exclusivamente georreferenciado de infraestrutura/energia/clima para uma **arquitetura híbrida multidomínio** cobrindo:
- **TI:** servidores, VMs, bancos de dados, APIs e serviços de negócio (`georeference_mode: none | optional`).
- **Redes / Telecom:** roteadores, switches, firewalls, OLTs, enlaces de fibra/rádio e conectores externos (Zabbix, PRTG, SLAview).
- **IoT:** gateways e sensores de campo via MQTT/TLS, HTTP e webhooks autenticados.
- **Energia:** UPS/nobreaks, retificadores, geradores e eventos de concessionária.
- **Ambiente / Clima:** estações meteorológicas, Open-Meteo (real), INMET e CEMADEN.

## 2. Fluxo Lógico de Ingestão e Armazenamento Separado
1. **Conectores Externos (`src/server/integrations.ts`):**
   - Catálogo extensível (`GET /api/integrations/catalog`) sem enums rígidos no banco.
   - `Open-Meteo` emite eventos climáticos em `canonical_events` e séries numéricas normalizadas (`°C`, `mm`, `km/h`, `hPa`) em `metric_samples`.
   - `Telcomanager SLAview` permanece explicitamente marcado como `PENDING_EXTERNAL_SPEC` / `NOT_CONFIGURED` até confirmação de documentação oficial, URL, versão e autenticação.
   - Ingestão CSV histórica é incremental por lotes com `ingestion_checkpoints` (`rows_processed`, `bytes_processed`, retomada sem duplicação).
2. **Coleta Nativa Autorizada (`src/server/collection.ts` & `services/ingestion/native_collectors.py`):**
   - Suporta `snmp_v3`, `mqtt`, `icmp`, `otlp` e `http_agent`.
   - Qualquer ingestão nativa ou OTLP (`/api/collection/native/ingest`, `/api/collection/otlp/v1/*`) exige correspondência em `authorized_collection_scopes` ativo do tenant; tentativas fora de escopo são bloqueadas com HTTP `403` e registradas em `audit_logs` (`UNAUTHORIZED_COLLECTION_TARGET`).
   - Wildcards irrestritos (`*`) são bloqueados.
3. **Separação de Dados Operacionais:**
   - **Métricas (Séries Temporais):** `metric_samples` (unidade, qualidade, timestamp UTC, `idempotency_key`).
   - **Logs Operacionais:** `operational_logs` (`severity`, `trace_id`, `attributes_json`).
   - **Eventos Canônicos:** `canonical_events` (mudanças de estado, alertas e previsões com `forecast_issued_at_utc`).
   - **Anomalias Estatísticas:** `anomaly_detections` (Z-Score com mínimo estrito de `>= 5` amostras válidas anteriores).
   - **Incidentes e RCA:** `incidents` + `incident_events` com `impacted_services_count` calculado via `topology_edges` e `service_dependencies`.

## 3. Persistência e Estratégia de Produção
- **Preview / SQLite:** `data/aiops.db` com WAL, chaves estrangeiras ativas e motor de migração versionado (`src/server/migrations.ts`, backup automático antes de evoluções).
- **Alvo Produção / PostgreSQL + PostGIS:** `infra/migrations/001_init_postgres.sql` e `002_hybrid_observability.sql`, com **Row-Level Security (RLS)** por `tenant_id` e particionamento mensal por `observed_at_utc` para `metric_samples` e `operational_logs` (sem necessidade de TimescaleDB obrigatório na partida, preservando simplicidade operacional; Redis reservado apenas para fila/rate-limiting distribuído quando houver múltiplos workers).
