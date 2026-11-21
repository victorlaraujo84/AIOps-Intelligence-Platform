// Executado via stdin no contêiner Web. Escreve somente um backup de fixtures no stdout.
import { createReadStream } from 'node:fs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openDatabase } from './src/server/db.ts';
import { hashPassword } from './src/server/security.ts';

const db = openDatabase(':memory:');
const ids = Array.from({ length: 18 }, (_, i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`);
const [tenant, concession, locality, category, site, physicalAsset, logicalAsset, edge, service, dependency, admin, operator, audit, globalAudit, connector, event, incident, sample] = ids;
const now = '2026-11-21T12:00:00.000Z';
const label = 'São Paulo\\N\tfixture\nsegunda linha';
const insert = (table, columns, values) => {
  const fields = columns.split(' ');
  db.prepare(`INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...values);
};

db.transaction(() => {
  insert('tenants', 'id name slug document created_at_utc updated_at_utc', [tenant, label, 'inventory-fixture', 'fixture-only', now, now]);
  insert('users', 'id email full_name role password_hash is_active created_at_utc',
    [admin, 'admin@example.invalid', 'Admin fixture', 'super_admin', hashPassword('admin-fixture-only'), 1, now]);
  insert('users', 'id tenant_id email full_name role password_hash is_active created_at_utc last_login_utc',
    [operator, tenant, 'operator@example.invalid', 'Operador fixture', 'tenant_operator', hashPassword('operator-fixture-only'), 0, now, now]);
  insert('sessions', 'id user_id active_tenant_id token_hash expires_at_utc created_at_utc',
    [admin, admin, tenant, 'a'.repeat(64), '2026-11-21T13:00:00.000Z', now]);
  insert('concessions', 'id tenant_id name code created_at_utc', [concession, tenant, label, 'concession', now]);
  insert('locality_types', 'id tenant_id code label created_at_utc', [locality, tenant, 'locality', label, now]);
  insert('asset_categories', 'id tenant_id code label domain created_at_utc', [category, tenant, 'category', label, 'iot', now]);
  insert(
    'sites',
    'id tenant_id concession_id locality_type_id code name uf latitude longitude coord_precision coord_verified created_at_utc updated_at_utc',
    [site, tenant, concession, locality, 'site', label, 'SP', -23.55, -46.63, 'manual_verificada', 1, now, now],
  );
  insert('assets', 'id tenant_id site_id category_id name domain georeference_mode ip_address created_at_utc updated_at_utc',
    [physicalAsset, tenant, site, category, label, 'iot', 'required', '2001:db8::1', now, now]);
  insert('assets', 'id tenant_id topology_parent_id name domain georeference_mode metadata_json created_at_utc updated_at_utc',
    [logicalAsset, tenant, physicalAsset, label, 'ti', 'none', JSON.stringify({ label, sequence: [1, 2] }), now, now]);
  insert('topology_edges', 'id tenant_id source_asset_id target_asset_id link_type is_redundant created_at_utc',
    [edge, tenant, physicalAsset, logicalAsset, 'depends_on', 1, now]);
  insert('services', 'id tenant_id code name created_at_utc updated_at_utc', [service, tenant, 'service', label, now, now]);
  insert('service_dependencies', 'id tenant_id service_id asset_id created_at_utc', [dependency, tenant, service, logicalAsset, now]);
  insert('connectors', 'id tenant_id connector_type name config_json created_at_utc updated_at_utc',
    [connector, tenant, 'open_meteo', 'Conector fixture', JSON.stringify({ source: label }), now, now]);
  insert('canonical_events', 'id tenant_id site_id asset_id connector_id idempotency_key event_time_utc observed_at_utc ingested_at_utc source event_type status',
    [event, tenant, site, physicalAsset, connector, 'fixture-event', now, now, now, 'fixture', 'fixture', 'OPEN']);
  insert('incidents', 'id tenant_id root_site_id root_asset_id title opened_at_utc rca_evidence_json',
    [incident, tenant, site, physicalAsset, label, now, JSON.stringify([{ evidence: label }])]);
  insert('incident_events', 'incident_id event_id tenant_id', [incident, event, tenant]);
  insert('metric_samples', 'id tenant_id asset_id site_id service_id connector_id idempotency_key metric_name value_num unit observed_at_utc ingested_at_utc source',
    [sample, tenant, physicalAsset, site, service, connector, 'fixture-sample', 'fixture', 1, 'count', now, now, 'fixture']);
  insert('ai_agent_configs', 'tenant_id updated_at_utc', [tenant, now]);
  insert('audit_logs',
    'id tenant_id actor_user_id actor_email actor_role action resource_type resource_id details_json ip_address created_at_utc',
    [audit, tenant, admin, 'admin@example.invalid', 'super_admin', 'AUDIT_IMPORTED', 'site', 'legacy/site',
      JSON.stringify({ label }), '192.0.2.10', now]);
  insert('audit_logs', 'id actor_user_id actor_role action resource_type resource_id ip_address created_at_utc',
    [globalAudit, admin, 'super_admin', 'AUDIT_IMPORTED_GLOBAL', 'system', 'legacy/global', 'unknown', now]);
})();

const dir = await mkdtemp(join(tmpdir(), 'inventory-rehearsal-'));
const snapshot = join(dir, 'fixture.db');
try {
  await db.backup(snapshot);
  await pipeline(createReadStream(snapshot), process.stdout);
} finally {
  db.close();
  await unlink(snapshot);
  await rmdir(dir);
}
