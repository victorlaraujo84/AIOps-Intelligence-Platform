import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function openDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (dbPath !== ':memory:' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  initSchema(db);
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      document TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('super_admin', 'tenant_admin', 'tenant_operator', 'tenant_viewer')),
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at_utc TEXT NOT NULL,
      last_login_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      active_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at_utc TEXT NOT NULL,
      created_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS concessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT NOT NULL,
      region TEXT,
      description TEXT,
      created_at_utc TEXT NOT NULL,
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE IF NOT EXISTS locality_types (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      created_at_utc TEXT NOT NULL,
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      concession_id TEXT REFERENCES concessions(id) ON DELETE SET NULL,
      locality_type_id TEXT REFERENCES locality_types(id) ON DELETE SET NULL,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      cep TEXT,
      municipality TEXT,
      uf TEXT,
      latitude REAL,
      longitude REAL,
      coord_precision TEXT NOT NULL DEFAULT 'pendente' CHECK (coord_precision IN ('manual_verificada', 'geocodificada', 'pendente')),
      coord_verified INTEGER NOT NULL DEFAULT 0,
      criticality TEXT NOT NULL DEFAULT 'media' CHECK (criticality IN ('critica', 'alta', 'media', 'baixa')),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL,
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE IF NOT EXISTS asset_categories (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      label TEXT NOT NULL,
      domain TEXT NOT NULL CHECK (domain IN ('rede', 'energia', 'infra', 'sensor')),
      created_at_utc TEXT NOT NULL,
      UNIQUE (tenant_id, code)
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
      category_id TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      hostname TEXT,
      ip_address TEXT,
      vendor TEXT,
      model TEXT,
      provider_name TEXT,
      redundancy_group TEXT,
      topology_parent_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      criticality TEXT NOT NULL DEFAULT 'media' CHECK (criticality IN ('critica', 'alta', 'media', 'baixa')),
      operational_state TEXT NOT NULL DEFAULT 'NO_DATA' CHECK (operational_state IN ('NO_DATA', 'UP', 'DEGRADED', 'DOWN', 'MAINTENANCE')),
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS topology_edges (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      source_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      target_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      link_type TEXT NOT NULL,
      provider_name TEXT,
      capacity_mbps REAL,
      is_redundant INTEGER NOT NULL DEFAULT 0,
      created_at_utc TEXT NOT NULL,
      UNIQUE (tenant_id, source_asset_id, target_asset_id, link_type)
    );

    CREATE TABLE IF NOT EXISTS connectors (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('open_meteo', 'inmet', 'cemaden', 'zabbix', 'prtg', 'snmp_trap', 'energy_ups', 'webhook_csv')),
      name TEXT NOT NULL,
      endpoint_url TEXT,
      auth_mode TEXT NOT NULL DEFAULT 'none' CHECK (auth_mode IN ('none', 'api_key', 'bearer', 'basic')),
      encrypted_credentials TEXT,
      config_json TEXT NOT NULL DEFAULT '{}',
      poll_interval_sec INTEGER NOT NULL DEFAULT 300,
      status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED' CHECK (status IN ('NOT_CONFIGURED', 'CONFIGURED', 'HEALTHY', 'ERROR', 'SOURCE_STALE')),
      last_sync_at_utc TEXT,
      last_error TEXT,
      created_at_utc TEXT NOT NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS connector_sync_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      started_at_utc TEXT NOT NULL,
      finished_at_utc TEXT,
      status TEXT NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'ERROR')),
      records_ingested INTEGER NOT NULL DEFAULT 0,
      records_deduplicated INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER,
      error_message TEXT,
      raw_metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS canonical_events (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
      asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
      idempotency_key TEXT NOT NULL,
      event_time_utc TEXT NOT NULL,
      observed_at_utc TEXT NOT NULL,
      ingested_at_utc TEXT NOT NULL,
      forecast_issued_at_utc TEXT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      lat REAL,
      lon REAL,
      quality_flag TEXT NOT NULL DEFAULT 'VALID' CHECK (quality_flag IN ('VALID', 'STALE', 'SUSPECT', 'UNVERIFIED_COORDS')),
      payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (tenant_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      root_site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
      root_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
      severity TEXT NOT NULL DEFAULT 'MEDIA' CHECK (severity IN ('CRITICA', 'ALTA', 'MEDIA', 'BAIXA')),
      rca_category TEXT NOT NULL DEFAULT 'desconhecida' CHECK (rca_category IN ('eletrica', 'climatica_direta', 'composta', 'telecom_outros', 'desconhecida')),
      rca_confidence REAL,
      rca_evidence_json TEXT NOT NULL DEFAULT '[]',
      rule_version TEXT NOT NULL DEFAULT 'rca-rules-v1.0',
      human_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      human_reviewed_at_utc TEXT,
      opened_at_utc TEXT NOT NULL,
      resolved_at_utc TEXT
    );

    CREATE TABLE IF NOT EXISTS incident_events (
      incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES canonical_events(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role_in_incident TEXT NOT NULL DEFAULT 'symptom',
      PRIMARY KEY (incident_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS ai_agent_configs (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'offline' CHECK (mode IN ('offline', 'openai', 'ollama')),
      endpoint_url TEXT,
      encrypted_api_key TEXT,
      model_name TEXT,
      data_sharing_authorized INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER NOT NULL DEFAULT 15000,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at_utc TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
      actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      details_json TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      created_at_utc TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_assets_tenant_site ON assets(tenant_id, site_id);
    CREATE INDEX IF NOT EXISTS idx_events_tenant_time ON canonical_events(tenant_id, event_time_utc DESC);
    CREATE INDEX IF NOT EXISTS idx_incidents_tenant_status ON incidents(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_logs(tenant_id, created_at_utc DESC);
  `);
}

const DEFAULT_LOCALITY_TYPES: Array<{ code: string; label: string; description: string }> = [
  { code: 'SEDE', label: 'Sede Administrativa / NOC', description: 'Unidade central corporativa ou NOC' },
  { code: 'LOJA', label: 'Loja / Atendimento', description: 'Ponto comercial ou atendimento presencial' },
  { code: 'ETA', label: 'ETA (Estação de Tratamento de Água)', description: 'Infraestrutura operacional de água' },
  { code: 'ETE', label: 'ETE (Estação de Tratamento de Esgoto)', description: 'Infraestrutura operacional de esgoto' },
  { code: 'ELEVATORIA', label: 'Estação Elevatória', description: 'Estação de bombeamento e recalque' },
  { code: 'SUBESTACAO', label: 'Subestação Elétrica', description: 'Subestação de energia ou média tensão' },
  { code: 'TORRE_RADIO', label: 'Torre / Rádio Enlace', description: 'Repetidora, torre de telecom ou rádio enlace' },
  { code: 'CENTRO_DIST', label: 'Centro de Distribuição', description: 'Centro logístico ou operacional' },
];

const DEFAULT_ASSET_CATEGORIES: Array<{ code: string; label: string; domain: 'rede' | 'energia' | 'infra' | 'sensor' }> = [
  { code: 'router', label: 'Roteador', domain: 'rede' },
  { code: 'switch', label: 'Switch', domain: 'rede' },
  { code: 'firewall', label: 'Firewall', domain: 'rede' },
  { code: 'server', label: 'Servidor', domain: 'infra' },
  { code: 'radio_link', label: 'Rádio Enlace', domain: 'rede' },
  { code: 'olt', label: 'OLT GPON', domain: 'rede' },
  { code: 'access_point', label: 'Access Point', domain: 'rede' },
  { code: 'ups', label: 'UPS / Nobreak', domain: 'energia' },
  { code: 'generator', label: 'Grupo Gerador', domain: 'energia' },
];

/**
 * Inicializa exclusivamente a taxonomia estrutural padrão do tenant (tipos de localidade e categorias de ativos).
 * NUNCA cria sites, ativos, incidentes ou métricas operacionais fictícias.
 */
export function initializeTenantTaxonomy(db: Database.Database, tenantId: string): void {
  const now = new Date().toISOString();
  const insertLoc = db.prepare(`
    INSERT OR IGNORE INTO locality_types (id, tenant_id, code, label, description, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const loc of DEFAULT_LOCALITY_TYPES) {
    insertLoc.run(crypto.randomUUID(), tenantId, loc.code, loc.label, loc.description, now);
  }

  const insertCat = db.prepare(`
    INSERT OR IGNORE INTO asset_categories (id, tenant_id, code, label, domain, created_at_utc)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const cat of DEFAULT_ASSET_CATEGORIES) {
    insertCat.run(crypto.randomUUID(), tenantId, cat.code, cat.label, cat.domain, now);
  }

  db.prepare(`
    INSERT OR IGNORE INTO ai_agent_configs (tenant_id, mode, data_sharing_authorized, timeout_ms, updated_at_utc)
    VALUES (?, 'offline', 0, 15000, ?)
  `).run(tenantId, now);
}

export function writeAuditLog(
  db: Database.Database,
  entry: {
    tenant_id: string | null;
    actor_user_id: string | null;
    actor_email: string | null;
    actor_role: string | null;
    action: string;
    resource_type: string;
    resource_id?: string | null;
    details?: Record<string, unknown>;
    ip_address?: string | null;
  },
): void {
  db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_user_id, actor_email, actor_role,
      action, resource_type, resource_id, details_json, ip_address, created_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    entry.tenant_id,
    entry.actor_user_id,
    entry.actor_email,
    entry.actor_role,
    entry.action,
    entry.resource_type,
    entry.resource_id ?? null,
    JSON.stringify(entry.details ?? {}),
    entry.ip_address ?? null,
    new Date().toISOString(),
  );
}
