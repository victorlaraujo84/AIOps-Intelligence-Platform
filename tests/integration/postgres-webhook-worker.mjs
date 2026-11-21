import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const root = (process.env.AIOPS_POSTGRES_CONSOLE_TEST_ORIGIN ?? 'https://localhost') + '/api/postgres-console';
const tenant = '00000000-0000-4000-9000-000000000001';
const incident = '/inventory/incidents/00000000-0000-4000-9000-000000000017';
const path = '/inventory/webhooks';

function session() {
  let cookie;
  return async (suffix, status, payload, method = payload ? 'POST' : 'GET') => {
    const headers = new Headers({ 'X-AIOps-Expected-Tenant': tenant });
    if (cookie) headers.set('Cookie', cookie);
    if (payload) headers.set('Content-Type', 'application/json');
    const response = await fetch(root + suffix, { method, headers, body: payload ? JSON.stringify(payload) : undefined });
    assert.equal(response.status, status, suffix);
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
    return response.status === 204 ? undefined : response.json();
  };
}

const admin = session();
const viewer = session();
assert.equal((await admin('/status', 200)).notifications, true);
await admin('/login', 204, { email: 'admin@example.invalid', password: 'admin-fixture-only' });
await admin('/switch-tenant', 200, { tenant_id: tenant });
assert.equal((await admin(path, 200)).items.length, 0);
const policy = { name: 'Webhook fixture', event_types: ['incident.reopened'], critical_only: false };
await admin(path, 422, { ...policy, origin: 'https://localhost' });
const { id } = await admin(path, 201, { ...policy, origin: 'https://webhook.example.invalid' });
await viewer('/login', 204, { email: 'release-viewer@example.invalid', password: 'viewer-fixture-only' });
await viewer(path, 403);
await viewer(path + '/' + id + '/status', 403, { enabled: true }, 'PATCH');
await admin(path + '/' + id + '/status', 200, { enabled: true }, 'PATCH');

const old = (await admin(incident, 200)).incident.human_reviewed_at_utc;
await admin(incident + '/rca-review', 200, { expected_review: old, status: 'OPEN' }, 'PATCH');
let entries = [];
for (let attempt = 0; attempt < 30; attempt++) {
  entries = (await admin(path + '/' + id + '/deliveries', 200)).items;
  if (entries[0]?.state === 'DEAD_LETTER') break;
  await delay(350);
}
assert.equal(entries.length, 1);
assert.equal(entries[0].state, 'DEAD_LETTER');
assert.equal(entries[0].attempt_count, 1);
assert.equal(entries[0].outcome, 'NOT_CONFIGURED');
assert.equal(entries[0].http_status, null);
await admin(path + '/' + id + '/status', 200, { enabled: false }, 'PATCH');
await admin('/logout', 204, {});
await viewer('/logout', 204, {});
console.log('Worker de webhook validado com fixture sem origem habilitada.');
