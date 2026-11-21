import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

const origin = process.env.AIOPS_POSTGRES_CONSOLE_TEST_ORIGIN ?? 'https://localhost';
const root = '/api/postgres-console';
const path = '/inventory/incidents/00000000-0000-4000-9000-000000000017/itsm/tickets';
const integrationId = '00000000-0000-4000-9000-000000000051';
const tenantId = '00000000-0000-4000-9000-000000000001';
let cookie;
async function request(path, ok, body) {
  const headers = new Headers({ 'X-AIOps-Expected-Tenant': tenantId });
  if (cookie) headers.set('Cookie', cookie);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(origin + root + path, {
    headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, ok, path);
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return response.status === 204 ? undefined : response.json();
}

assert.equal((await request('/status', 200)).itsm, true);
await request('/login', 204, { email: 'release-viewer@example.invalid', password: 'viewer-fixture-only' });
let response = await request(path, 200);
assert.equal(response.items[0].integration_id, integrationId);
assert.equal(response.items[0].state, null);
await request(path, 403, { integration_id: integrationId });
await request('/logout', 204, {});
await request('/login', 204, { email: 'release-operator@example.invalid', password: 'operator-fixture-only' });
const first = await request(path, 202, { integration_id: integrationId });
assert.ok(first.operation_id);
assert.equal((await request(path, 202, { integration_id: integrationId })).operation_id, first.operation_id);
for (let attempt = 0; attempt < 40; attempt++) {
  response = await request(path, 200);
  if (response.items[0].state === 'FAILED') break;
  await setTimeout(250);
}
assert.equal(response.items[0].state, 'FAILED');
assert.equal(response.items[0].last_error, 'NOT_CONFIGURED');
assert.equal(response.items[0].external_id, null);
await request('/logout', 204, {});
console.log('Fluxo PostgreSQL e worker sem destino comprovados por HTTPS com fixture descartável.');
