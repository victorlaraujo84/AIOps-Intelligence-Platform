import assert from 'node:assert/strict';

const origin = process.env.AIOPS_POSTGRES_CONSOLE_TEST_ORIGIN ?? 'https://localhost';
const root = origin + '/api/postgres-console';
const tenantA = '00000000-0000-4000-b000-000000000001';
const tenantB = '00000000-0000-4000-b000-000000000003';

function client() {
  let cookie;
  return async (path, { data, headers: supplied, method, bearer, ...options } = {}) => {
    const headers = new Headers(supplied);
    if (cookie) headers.set('Cookie', cookie);
    if (bearer) headers.set('Authorization', 'Bearer ' + bearer);
    if (data !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(root + path, {
      method: method ?? (data === undefined ? 'GET' : 'POST'),
      headers,
      body: data === undefined ? undefined : JSON.stringify(data),
      ...options,
    });
    const value = response.headers.get('Set-Cookie');
    if (value) cookie = value.split(';', 1)[0];
    return response;
  };
}

const operator = client();
assert.equal((await fetch(origin + '/postgres-inventory')).status, 200);
assert.equal((await operator('/status')).status, 200);
assert.equal((await operator('/inventory/sites')).status, 401);
assert.equal((await operator('/inventory/sites', { bearer: 'X'.repeat(43) })).status, 401);
const login = { email: 'operator-auth@example.invalid', password: 'operator-ci-fixture-only' };
assert.equal((await operator('/login', { data: login, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
assert.equal((await operator('/login', { data: login, headers: { 'Content-Type': 'text/plain' } })).status, 403);
assert.equal((await operator('/login', { data: { ...login, password: 'inválida' } })).status, 401);
const response = await operator('/login', { data: login });
assert.equal(response.status, 204);
assert.equal(await response.text(), '');
const cookie = response.headers.get('Set-Cookie') || '';
assert.match(cookie, /^__Host-aiops_pg_session=[A-Za-z0-9_-]{43};/);
for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) {
  assert.ok(cookie.split('; ').includes(attribute));
}
assert.equal(response.headers.get('Cache-Control'), 'no-store');

const identity = await (await operator('/me')).json();
assert.equal(identity.active_tenant_id, tenantA);
const operatorTenants = await (await operator('/tenants')).json();
assert.deepEqual(operatorTenants.items.map(item => item.id), [tenantA]);
assert.equal((await operator('/switch-tenant', { data: { tenant_id: tenantB } })).status, 403);
const ownSites = await (await operator('/inventory/sites?tenant_id=' + tenantB)).json();
assert.ok(ownSites.items.some(site => site.code === 'MAP-SITE'));
assert.ok(ownSites.items.every(site => site.tenant_id === tenantA));
const box = '/inventory/sites/map?west=-47&south=-24&east=-46&north=-23';
const ownMap = await (await operator(box)).json();
assert.deepEqual(ownMap.items.map(site => site.code), ['MAP-SITE']);
assert.equal((await operator('/inventory/connectors')).status, 404);
assert.equal((await operator('/inventory/sites', { data: { name: 'fixture', code: 'fixture' } })).status, 404);
assert.equal((await operator('/logout', { data: {} })).status, 204);
assert.equal((await operator('/me')).status, 401);

const global = client();
assert.equal((await global('/login', {
  data: { email: 'global-auth@example.invalid', password: 'global-ci-fixture-only' },
})).status, 204);
assert.equal((await global('/inventory/sites')).status, 409);
const firstPage = await (await global('/tenants?limit=1')).json();
assert.deepEqual(firstPage.items.map(item => item.id), [tenantA]);
assert.equal(firstPage.next_after, tenantA);
const secondPage = await (await global('/tenants?limit=1&after=' + firstPage.next_after)).json();
assert.deepEqual(secondPage.items.map(item => item.id), [tenantB]);
assert.equal(secondPage.next_after, null);
assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
const otherMap = await (await global(box)).json();
assert.deepEqual(otherMap.items.map(site => site.code), ['MAP-FOREIGN']);
assert.equal((await global('/logout', { data: {} })).status, 204);
console.log('HTTPS, cookie de sessão, troca de tenant, inventário e marcadores PostgreSQL verificados.');
