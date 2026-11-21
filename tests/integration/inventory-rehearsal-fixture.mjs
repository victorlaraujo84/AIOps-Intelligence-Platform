// Executado via stdin no contêiner Web. Escreve somente um backup de fixtures no stdout.
import { createReadStream } from 'node:fs';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openDatabase } from './src/server/db.ts';

const db = openDatabase(':memory:');
const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-9000-${String(i + 1).padStart(12, '0')}`);
const [tenant, concession, locality, category, site, physicalAsset, logicalAsset, edge, service, dependency] = ids;
const now = '2026-11-21T12:00:00.000Z';
const label = 'São Paulo\\N\tfixture\nsegunda linha';
const insert = (table, columns, values) => {
  const fields = columns.split(' ');
  db.prepare(`INSERT INTO ${table} (${fields.join(', ')}) VALUES (${fields.map(() => '?').join(', ')})`).run(...values);
};

db.transaction(() => {
  insert('tenants', 'id name slug document created_at_utc updated_at_utc', [tenant, label, 'inventory-fixture', 'fixture-only', now, now]);
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
