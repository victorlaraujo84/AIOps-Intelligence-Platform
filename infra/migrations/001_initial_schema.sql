-- Migração inicial PostgreSQL + PostGIS + Row-Level Security (RLS)
-- AIOps Intelligence Platform

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  document TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'tenant_admin', 'tenant_operator', 'tenant_viewer')),
  password_hash TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_utc TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS concessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  region TEXT,
  description TEXT,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS locality_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  concession_id UUID REFERENCES concessions(id) ON DELETE SET NULL,
  locality_type_id UUID REFERENCES locality_types(id) ON DELETE SET NULL,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT,
  cep TEXT,
  municipality TEXT,
  uf CHAR(2),
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,
  geom GEOGRAPHY(Point, 4326),
  coord_precision TEXT NOT NULL DEFAULT 'pendente' CHECK (coord_precision IN ('manual_verificada', 'geocodificada', 'pendente')),
  coord_verified BOOLEAN NOT NULL DEFAULT FALSE,
  criticality TEXT NOT NULL DEFAULT 'media' CHECK (criticality IN ('critica', 'alta', 'media', 'baixa')),
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS asset_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (domain IN ('rede', 'energia', 'infra', 'sensor')),
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE IF NOT EXISTS assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  category_id UUID REFERENCES asset_categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  hostname TEXT,
  ip_address INET,
  vendor TEXT,
  model TEXT,
  provider_name TEXT,
  redundancy_group TEXT,
  topology_parent_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  criticality TEXT NOT NULL DEFAULT 'media' CHECK (criticality IN ('critica', 'alta', 'media', 'baixa')),
  operational_state TEXT NOT NULL DEFAULT 'NO_DATA' CHECK (operational_state IN ('NO_DATA', 'UP', 'DEGRADED', 'DOWN', 'MAINTENANCE')),
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS topology_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  target_asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,
  provider_name TEXT,
  capacity_mbps DOUBLE PRECISION,
  is_redundant BOOLEAN NOT NULL DEFAULT FALSE,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, source_asset_id, target_asset_id, link_type)
);

CREATE TABLE IF NOT EXISTS connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,
  name TEXT NOT NULL,
  endpoint_url TEXT,
  auth_mode TEXT NOT NULL DEFAULT 'none',
  encrypted_credentials TEXT,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  poll_interval_sec INTEGER NOT NULL DEFAULT 300,
  status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
  last_sync_at_utc TIMESTAMPTZ,
  last_error TEXT,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS canonical_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  connector_id UUID REFERENCES connectors(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  event_time_utc TIMESTAMPTZ NOT NULL,
  observed_at_utc TIMESTAMPTZ NOT NULL,
  ingested_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  forecast_issued_at_utc TIMESTAMPTZ,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lon DOUBLE PRECISION,
  quality_flag TEXT NOT NULL DEFAULT 'VALID',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  root_site_id UUID REFERENCES sites(id) ON DELETE SET NULL,
  root_asset_id UUID REFERENCES assets(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  severity TEXT NOT NULL DEFAULT 'MEDIA',
  rca_category TEXT NOT NULL DEFAULT 'desconhecida',
  rca_confidence DOUBLE PRECISION,
  rca_evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  rule_version TEXT NOT NULL DEFAULT 'rca-rules-v1.0',
  human_reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  human_reviewed_at_utc TIMESTAMPTZ,
  opened_at_utc TIMESTAMPTZ NOT NULL,
  resolved_at_utc TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address INET,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices espaciais e temporais
CREATE INDEX IF NOT EXISTS idx_sites_geom ON sites USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_events_tenant_observed ON canonical_events (tenant_id, observed_at_utc DESC);
CREATE INDEX IF NOT EXISTS idx_events_tenant_ingested ON canonical_events (tenant_id, ingested_at_utc);

-- Políticas PostgreSQL Row-Level Security (RLS)
-- O contexto de sessão deve definir: SET LOCAL app.current_tenant_id = '<uuid>';
ALTER TABLE concessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE locality_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE topology_edges ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_concessions ON concessions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_locality_types ON locality_types
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_sites ON sites
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_asset_categories ON asset_categories
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_assets ON assets
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_topology_edges ON topology_edges
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_connectors ON connectors
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_canonical_events ON canonical_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation_incidents ON incidents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
