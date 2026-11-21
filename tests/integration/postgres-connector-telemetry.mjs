import assert from 'node:assert/strict';

const origin = process.env.AIOPS_POSTGRES_CONSOLE_TEST_ORIGIN ?? 'https://localhost';
const root = '/api/postgres-console';
const tenant = '00000000-0000-4000-9000-000000000001';
const asset = '00000000-0000-4000-9000-000000000006';
const service = '00000000-0000-4000-9000-000000000009';
const connectors = '/inventory/connectors';

function session(email, password) {
  let cookie;
  return async (path, status, body, expected = tenant) => {
    const headers = new Headers({ 'X-AIOps-Expected-Tenant': expected });
    if (cookie) headers.set('Cookie', cookie);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(origin + root + path, {
      headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, status, path + ' (' + email + ')');
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
    return response.status === 204 ? undefined : response.json();
  };
}

const admin = session('admin@example.invalid', 'admin-fixture-only');
const operator = session('release-operator@example.invalid', 'operator-fixture-only');
const viewer = session('release-viewer@example.invalid', 'viewer-fixture-only');
await admin('/login', 204, { email: 'admin@example.invalid', password: 'admin-fixture-only' });
await admin('/switch-tenant', 200, { tenant_id: tenant });
const { id } = await admin(connectors, 201, { name: 'Telemetria fixture' });
const path = connectors + '/' + id + '/ingest';
await operator('/login', 204, { email: 'release-operator@example.invalid', password: 'operator-fixture-only' });
await viewer('/login', 204, { email: 'release-viewer@example.invalid', password: 'viewer-fixture-only' });

const observed = '2026-11-21T16:00:00Z';
const metric = { idempotency_key: 'telemetry-fixture', observed_at_utc: observed, source: 'telemetry_fixture',
  metric_name: 'fixture.temperature', value_num: 12.5, unit: 'Cel', asset_id: asset, service_id: service, tags: { sensor: 'fixture' } };
const log = { idempotency_key: metric.idempotency_key, observed_at_utc: observed, source: metric.source,
  severity: 'WARN', message: 'Linha fixture\nDetalhe', asset_id: asset, service_id: service,
  trace_id: 'trace-fixture', attributes: { ordinal: 2 } };

await viewer(path + '/logs', 403, { logs: [log] });
await operator(path + '/metrics', 422, { metrics: [{ ...metric, value_num: '12' }] });
await operator(path + '/logs', 422, { logs: [{ ...log, severity: 'UNKNOWN' }] });
await operator(path + '/metrics', 422, { metrics: [{ ...metric, tenant_id: tenant }] });
await operator(path + '/logs', 422, { logs: [{ ...log, message: '\u0000' }] });

const imported = await operator(path + '/metrics', 201, {
  metrics: [{ ...metric, idempotency_key: 'fixture-sample', observed_at_utc: '2026-11-21T17:00:00Z' }],
});
assert.deepEqual([imported.ingested, imported.deduplicated], [0, 1]);

const parallel = await Promise.all([
  admin(path + '/metrics', 201, { metrics: [metric] }),
  operator(path + '/metrics', 201, { metrics: [{ ...metric, observed_at_utc: '2026-11-21T18:00:00Z' }] }),
]);
assert.deepEqual(parallel.map(row => row.ingested).sort(), [0, 1]);
assert.deepEqual(parallel.map(row => row.deduplicated).sort(), [0, 1]);
assert.ok(parallel.every(row => row.run_id));

const other = await admin('/tenants', 201, { name: 'Telemetria isolada fixture' });
await admin('/switch-tenant', 200, { tenant_id: other.id });
await admin(path + '/logs', 409, { logs: [log] });
await admin(path + '/logs', 404, { logs: [log] }, other.id);
const { id: otherConnector } = await admin(connectors, 201, { name: 'Conector isolado fixture' }, other.id);
const otherPath = connectors + '/' + otherConnector + '/ingest/logs';
const isolatedLog = { ...log, asset_id: undefined, service_id: undefined };
await admin(otherPath, 422, { logs: [isolatedLog, log] }, other.id);
const afterRollback = await admin(otherPath, 201, { logs: [isolatedLog] }, other.id);
assert.deepEqual([afterRollback.ingested, afterRollback.deduplicated], [1, 0]);
assert.equal((await admin('/inventory/feed/metrics', 200, undefined, other.id)).items.length, 0);

const importedLog = await operator(path + '/logs', 201, { logs: [log, log] });
assert.deepEqual([importedLog.ingested, importedLog.deduplicated], [1, 1]);
const logs = (await viewer('/inventory/feed/logs', 200)).items.filter(row => row.source === log.source);
assert.equal(logs.length, 1);
assert.equal(logs[0].message, log.message);
assert.equal(logs[0].severity, log.severity);
const metrics = (await viewer('/inventory/feed/metrics', 200)).items.filter(row => row.source === metric.source);
assert.deepEqual(metrics.map(row => row.value_num), [metric.value_num]);

const audit = (await viewer('/inventory/audit', 200)).items;
assert.ok(audit.some(row => row.action === 'CONNECTOR_TELEMETRY_INGESTED' && row.resource_id === id));
await admin('/logout', 204, {});
await viewer('/logout', 204, {});
await operator('/logout', 204, {});
console.log('Métricas e logs aprovados por HTTPS com concorrência, atomicidade, auditoria e isolamento por tenant.');
