import assert from 'node:assert/strict';

const origin = process.env.AIOPS_POSTGRES_CONSOLE_TEST_ORIGIN ?? 'https://localhost';
const root = '/api/postgres-console';
const tenantId = '00000000-0000-4000-9000-000000000001';
const recoveryAsset = '00000000-0000-4000-9000-000000000007';
let cookie;
let expected = tenantId;
async function request(path, status, body, method = body === undefined ? 'GET' : 'POST') {
  const headers = new Headers({ 'X-AIOps-Expected-Tenant': expected });
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(origin + root + path, {
    headers, method, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, path);
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return response.status === 204 ? undefined : response.json();
}

const connectors = '/inventory/connectors';
assert.equal((await request('/status', 200)).connector_writes, true);
await request('/login', 204, { email: 'admin@example.invalid', password: 'admin-fixture-only' });
await request('/switch-tenant', 200, { tenant_id: tenantId });
const created = await request(connectors, 201, { name: 'Ingestão fixture' });
assert.equal((await request(connectors, 201, { name: 'Ingestão fixture' })).id, created.id);
const ingest = connectors + '/' + created.id + '/ingest';
await request('/logout', 204, {});
await request('/login', 204, { email: 'release-viewer@example.invalid', password: 'viewer-fixture-only' });
function event(idempotency_key, details = {}) {
  return { idempotency_key, source: 'fixture', event_type: 'network/link', status: 'outage',
    observed_at_utc: '2026-11-21T13:00:00Z', event_time_utc: '2026-11-21T13:00:00Z', ...details };
}
await request(ingest, 403, { events: [event('fixture-forbidden')] });
await request('/logout', 204, {});
await request('/login', 204, { email: 'release-operator@example.invalid', password: 'operator-fixture-only' });
await request(connectors, 403, { name: 'Bloqueado' });
expected = '00000000-0000-4000-9000-000000000091';
await request(ingest, 409, { events: [event('fixture-stale-tenant')] });
expected = tenantId;
await request(ingest, 422, { events: [event('fixture-time', { observed_at_utc: '2026-11-21T13:00:00' })] });
await request(ingest, 422, { events: [
  event('fixture-atomic'),
  event('fixture-invalid-asset', { asset_id: '00000000-0000-4000-9000-000000000092' }),
] });
const recovered = await request(ingest, 201, { events: [
  event('fixture-atomic', { asset_id: recoveryAsset }),
  event('fixture-atomic', { asset_id: recoveryAsset }),
  event('fixture-correlated', { asset_id: recoveryAsset }),
  event('fixture-ok', { status: 'up', asset_id: recoveryAsset, observed_at_utc: '2026-11-21T14:00:00Z' }),
] });
assert.equal(recovered.ingested, 3);
assert.equal(recovered.deduplicated, 1);
assert.equal(recovered.created_incidents, 1);
assert.ok(recovered.run_id);
const incidents = await request('/inventory/feed/incidents', 200);
const latest = incidents.items.find(row => row.id !== '00000000-0000-4000-9000-000000000017');
assert.equal(latest.impacted_services_count, 1);
assert.equal(latest.severity, 'CRITICA');
const detail = await request('/inventory/incidents/' + latest.id, 200);
assert.deepEqual(detail.events.map(row => row.role_in_incident).sort(), ['correlated', 'root_candidate']);
const assets = await request('/inventory/assets', 200);
assert.equal(assets.items.find(row => row.id === recoveryAsset).operational_state, 'UP');
const copied = await request(connectors, 200);
assert.equal(copied.items.find(row => row.id === created.id).status, 'HEALTHY');
await request('/logout', 204, {});
console.log('Ingestão canônica aprovada por HTTPS com lote, RCA, recuperação e isolamento.');
