-- Migração 002 PostgreSQL + PostGIS — Núcleo Híbrido de Observabilidade e Coleta Autorizada
-- Preserva 100% dos dados da migração 001_initial_schema.sql

ALTER TABLE assets ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS asset_type_code TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT 'infra';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS georeference_mode TEXT NOT NULL DEFAULT 'optional';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE incidents ADD COLUMN IF NOT EXISTS impacted_services_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  domain TEXT NOT NULL DEFAULT 'ti',
  criticality TEXT NOT NULL DEFAULT 'alta',
  owner_team TEXT,
  sla_target_pct DOUBLE PRECISION,
  operational_state TEXT NOT NULL DEFAULT 'NO_DATA',
  description TEXT,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS service_dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES assets(id) ON DELETE CASCADE,
  upstream_service_id UUID REFERENCES services(id) ON DELETE CASCADE,
  dependency_role TEXT NOT NULL DEFAULT 'primary',
  weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS metric_samples (
  id UUID DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  connector_id UUID REFERENCES connectors(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  value_num DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL,
  observed_at_utc TIMESTAMPTZ NOT NULL,
  ingested_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  quality_flag TEXT NOT NULL DEFAULT 'VALID',
  tags_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, observed_at_utc, id),
  UNIQUE (tenant_id, observed_at_utc, idempotency_key)
) PARTITION BY RANGE (observed_at_utc);

CREATE TABLE IF NOT EXISTS metric_samples_default PARTITION OF metric_samples DEFAULT;

CREATE TABLE IF NOT EXISTS operational_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  connector_id UUID REFERENCES connectors(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'INFO',
  message TEXT NOT NULL,
  observed_at_utc TIMESTAMPTZ NOT NULL,
  ingested_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL,
  trace_id TEXT,
  attributes_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  cursor_key TEXT NOT NULL,
  cursor_value TEXT NOT NULL,
  rows_processed INTEGER NOT NULL DEFAULT 0,
  bytes_processed BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, connector_id, cursor_key)
);

CREATE TABLE IF NOT EXISTS authorized_collection_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  protocol TEXT NOT NULL,
  target_cidr_or_host TEXT NOT NULL,
  port INTEGER,
  description TEXT,
  rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, protocol, target_cidr_or_host)
);

CREATE TABLE IF NOT EXISTS anomaly_detections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  metric_name TEXT NOT NULL,
  observed_value DOUBLE PRECISION NOT NULL,
  baseline_mean DOUBLE PRECISION NOT NULL,
  baseline_stddev DOUBLE PRECISION NOT NULL,
  z_score DOUBLE PRECISION NOT NULL,
  severity TEXT NOT NULL,
  detected_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'OPEN'
);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE metric_samples ENABLE ROW LEVEL SECURITY;
ALTER TABLE operational_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorized_collection_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_detections ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_services ON services
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_service_deps ON service_dependencies
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_metrics ON metric_samples
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_logs ON operational_logs
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_checkpoints ON ingestion_checkpoints
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_collection_scopes ON authorized_collection_scopes
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_anomalies ON anomaly_detections
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
