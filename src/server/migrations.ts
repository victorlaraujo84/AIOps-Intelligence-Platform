import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

function createPreMigrationBackup(db: Database.Database, dbPath: string, targetVersion: number): void {
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) {
    return;
  }
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(backupDir, `aiops-pre-v${targetVersion}-${stamp}.db`);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, backupFile);
  } catch {
    // Em caso de falha de cópia em filesystem restrito, não bloqueia memória/testes
  }
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

const MIGRATIONS: Migration[] = [
  {
    version: 2,
    name: '002_hybrid_universal_observability',
    up: (db) => {
      // 1. Remover CHECK rígido de asset_categories.domain mantendo dados existentes
      const catSql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='asset_categories'`).get() as
          | { sql: string }
          | undefined
      )?.sql;
      if (catSql && catSql.includes('CHECK')) {
        db.exec(`
          CREATE TABLE asset_categories_new (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            code TEXT NOT NULL,
            label TEXT NOT NULL,
            domain TEXT NOT NULL DEFAULT 'infra',
            created_at_utc TEXT NOT NULL,
            UNIQUE (tenant_id, code)
          );
          INSERT INTO asset_categories_new (id, tenant_id, code, label, domain, created_at_utc)
            SELECT id, tenant_id, code, label, domain, created_at_utc FROM asset_categories;
          DROP TABLE asset_categories;
          ALTER TABLE asset_categories_new RENAME TO asset_categories;
        `);
      }

      // 2. Evoluir assets: tornar site_id anulável e adicionar domain, asset_type_code, georeference_mode e metadata_json
      if (!tableHasColumn(db, 'assets', 'georeference_mode')) {
        db.exec(`
          CREATE TABLE assets_new (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
            category_id TEXT REFERENCES asset_categories(id) ON DELETE SET NULL,
            asset_type_code TEXT,
            domain TEXT NOT NULL DEFAULT 'infra',
            georeference_mode TEXT NOT NULL DEFAULT 'optional' CHECK (georeference_mode IN ('required', 'optional', 'none')),
            name TEXT NOT NULL,
            hostname TEXT,
            ip_address TEXT,
            vendor TEXT,
            model TEXT,
            provider_name TEXT,
            redundancy_group TEXT,
            topology_parent_id TEXT REFERENCES assets_new(id) ON DELETE SET NULL,
            criticality TEXT NOT NULL DEFAULT 'media' CHECK (criticality IN ('critica', 'alta', 'media', 'baixa')),
            operational_state TEXT NOT NULL DEFAULT 'NO_DATA' CHECK (operational_state IN ('NO_DATA', 'UP', 'DEGRADED', 'DOWN', 'MAINTENANCE')),
            metadata_json TEXT NOT NULL DEFAULT '{}',
            created_at_utc TEXT NOT NULL,
            updated_at_utc TEXT NOT NULL
          );
          INSERT INTO assets_new (
            id, tenant_id, site_id, category_id, asset_type_code, domain, georeference_mode,
            name, hostname, ip_address, vendor, model, provider_name, redundancy_group,
            topology_parent_id, criticality, operational_state, metadata_json, created_at_utc, updated_at_utc
          )
          SELECT
            a.id, a.tenant_id, a.site_id, a.category_id,
            COALESCE(ac.code, NULL),
            COALESCE(ac.domain, 'infra'),
            CASE WHEN a.site_id IS NOT NULL THEN 'required' ELSE 'optional' END,
            a.name, a.hostname, a.ip_address, a.vendor, a.model, a.provider_name, a.redundancy_group,
            a.topology_parent_id, a.criticality, a.operational_state, '{}', a.created_at_utc, a.updated_at_utc
          FROM assets a
          LEFT JOIN asset_categories ac ON ac.id = a.category_id;
          DROP TABLE assets;
          ALTER TABLE assets_new RENAME TO assets;
          CREATE INDEX IF NOT EXISTS idx_assets_tenant_site ON assets(tenant_id, site_id);
          CREATE INDEX IF NOT EXISTS idx_assets_tenant_domain ON assets(tenant_id, domain);
        `);
      }

      // 3. Remover CHECK rígido de connectors.connector_type para permitir SLAview, MQTT, OTLP, SNMPv3, ICMP e customizados
      const connSql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='connectors'`).get() as
          | { sql: string }
          | undefined
      )?.sql;
      if (connSql && connSql.includes("connector_type IN ('open_meteo'")) {
        db.exec(`
          CREATE TABLE connectors_new (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            connector_type TEXT NOT NULL,
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
          INSERT INTO connectors_new SELECT * FROM connectors;
          DROP TABLE connectors;
          ALTER TABLE connectors_new RENAME TO connectors;
        `);
      }

      // 4. Remover CHECK rígido de incidents.rca_category para suportar ti_aplicacao e iot_sensor
      const incSql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='incidents'`).get() as
          | { sql: string }
          | undefined
      )?.sql;
      if (incSql && !incSql.includes('ti_aplicacao')) {
        db.exec(`
          CREATE TABLE incidents_new (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            root_site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
            root_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
            severity TEXT NOT NULL DEFAULT 'MEDIA' CHECK (severity IN ('CRITICA', 'ALTA', 'MEDIA', 'BAIXA')),
            impacted_services_count INTEGER NOT NULL DEFAULT 0,
            rca_category TEXT NOT NULL DEFAULT 'desconhecida',
            rca_confidence REAL,
            rca_evidence_json TEXT NOT NULL DEFAULT '[]',
            rule_version TEXT NOT NULL DEFAULT 'rca-rules-v2.0',
            human_reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
            human_reviewed_at_utc TEXT,
            opened_at_utc TEXT NOT NULL,
            resolved_at_utc TEXT
          );
          INSERT INTO incidents_new (
            id, tenant_id, root_site_id, root_asset_id, title, status, severity,
            impacted_services_count, rca_category, rca_confidence, rca_evidence_json,
            rule_version, human_reviewed_by, human_reviewed_at_utc, opened_at_utc, resolved_at_utc
          )
          SELECT
            id, tenant_id, root_site_id, root_asset_id, title, status, severity,
            0, rca_category, rca_confidence, rca_evidence_json,
            rule_version, human_reviewed_by, human_reviewed_at_utc, opened_at_utc, resolved_at_utc
          FROM incidents;
          DROP TABLE incidents;
          ALTER TABLE incidents_new RENAME TO incidents;
          CREATE INDEX IF NOT EXISTS idx_incidents_tenant_status ON incidents(tenant_id, status);
        `);
      }

      // 5. Novas tabelas do núcleo híbrido: services, service_dependencies, metric_samples, operational_logs,
      //    ingestion_checkpoints, authorized_collection_scopes, anomaly_detections
      db.exec(`
        CREATE TABLE IF NOT EXISTS services (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          code TEXT NOT NULL,
          name TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT 'ti',
          criticality TEXT NOT NULL DEFAULT 'alta' CHECK (criticality IN ('critica', 'alta', 'media', 'baixa')),
          owner_team TEXT,
          sla_target_pct REAL,
          operational_state TEXT NOT NULL DEFAULT 'NO_DATA' CHECK (operational_state IN ('NO_DATA', 'UP', 'DEGRADED', 'DOWN', 'MAINTENANCE')),
          description TEXT,
          created_at_utc TEXT NOT NULL,
          updated_at_utc TEXT NOT NULL,
          UNIQUE (tenant_id, code)
        );

        CREATE TABLE IF NOT EXISTS service_dependencies (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
          upstream_service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
          dependency_role TEXT NOT NULL DEFAULT 'primary' CHECK (dependency_role IN ('primary', 'redundant', 'supporting')),
          weight REAL NOT NULL DEFAULT 1.0,
          created_at_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS metric_samples (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
          service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
          site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
          connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
          idempotency_key TEXT NOT NULL,
          metric_name TEXT NOT NULL,
          value_num REAL NOT NULL,
          unit TEXT NOT NULL,
          observed_at_utc TEXT NOT NULL,
          ingested_at_utc TEXT NOT NULL,
          source TEXT NOT NULL,
          quality_flag TEXT NOT NULL DEFAULT 'VALID' CHECK (quality_flag IN ('VALID', 'STALE', 'SUSPECT', 'UNVERIFIED_COORDS')),
          tags_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE (tenant_id, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS operational_logs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
          service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
          site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
          connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
          idempotency_key TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'INFO' CHECK (severity IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')),
          message TEXT NOT NULL,
          observed_at_utc TEXT NOT NULL,
          ingested_at_utc TEXT NOT NULL,
          source TEXT NOT NULL,
          trace_id TEXT,
          attributes_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE (tenant_id, idempotency_key)
        );

        CREATE TABLE IF NOT EXISTS ingestion_checkpoints (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
          cursor_key TEXT NOT NULL,
          cursor_value TEXT NOT NULL,
          rows_processed INTEGER NOT NULL DEFAULT 0,
          bytes_processed INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'COMPLETED' CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'FAILED')),
          updated_at_utc TEXT NOT NULL,
          UNIQUE (tenant_id, connector_id, cursor_key)
        );

        CREATE TABLE IF NOT EXISTS authorized_collection_scopes (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          protocol TEXT NOT NULL CHECK (protocol IN ('snmp_v3', 'mqtt', 'icmp', 'otlp', 'http_agent')),
          target_cidr_or_host TEXT NOT NULL,
          port INTEGER,
          description TEXT,
          rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
          is_active INTEGER NOT NULL DEFAULT 1,
          approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          approved_at_utc TEXT NOT NULL,
          UNIQUE (tenant_id, protocol, target_cidr_or_host)
        );

        CREATE TABLE IF NOT EXISTS anomaly_detections (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
          service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
          metric_name TEXT NOT NULL,
          observed_value REAL NOT NULL,
          baseline_mean REAL NOT NULL,
          baseline_stddev REAL NOT NULL,
          z_score REAL NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN ('ALTA', 'MEDIA')),
          detected_at_utc TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'DISMISSED'))
        );

        CREATE INDEX IF NOT EXISTS idx_services_tenant ON services(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_metrics_tenant_time ON metric_samples(tenant_id, metric_name, observed_at_utc DESC);
        CREATE INDEX IF NOT EXISTS idx_logs_tenant_time ON operational_logs(tenant_id, observed_at_utc DESC);
        CREATE INDEX IF NOT EXISTS idx_anomalies_tenant ON anomaly_detections(tenant_id, status, detected_at_utc DESC);
      `);
    },
  },
];

export function runSqliteMigrations(db: Database.Database, dbPath: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at_utc TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map((r) => r.version),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    // Cria backup antes da migração caso já existam tenants/usuários
    const hasData =
      (db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }).c > 0 ||
      (db.prepare('SELECT COUNT(*) AS c FROM tenants').get() as { c: number }).c > 0;
    if (hasData) {
      createPreMigrationBackup(db, dbPath, migration.version);
    }

    db.pragma('foreign_keys = OFF');
    try {
      const trx = db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at_utc) VALUES (?, ?, ?)').run(
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
      });
      trx();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
}
