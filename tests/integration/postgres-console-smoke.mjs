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

if (process.argv.includes('--imported-pilot')) {
  const imported = client();
  const id = '00000000-0000-4000-9000-000000000001';
  const home = await fetch(origin + '/', { redirect: 'manual' });
  assert.equal(home.status, 302);
  assert.equal(home.headers.get('Location'), '/postgres-inventory');
  assert.equal((await fetch(origin + '/api/auth/status')).status, 404);
  assert.deepEqual(await (await imported('/status')).json(), {
    enabled: true, pilot_only: true, site_writes: false, asset_writes: false, service_writes: false,
  });
  assert.equal((await imported('/inventory/sites')).status, 401);
  assert.equal((await imported('/login', {
    data: { email: 'operator@example.invalid', password: 'operator-fixture-only' },
  })).status, 401);
  assert.equal((await imported('/login', {
    data: { email: 'admin@example.invalid', password: 'admin-fixture-only' },
  })).status, 204);
  const account = await (await imported('/me')).json();
  assert.equal(account.active_tenant_id, null);
  const tenants = await (await imported('/tenants')).json();
  assert.deepEqual(tenants.items.map(item => item.id), [id]);
  assert.equal((await imported('/switch-tenant', { data: { tenant_id: id } })).status, 200);
  const sites = await (await imported('/inventory/sites')).json();
  assert.deepEqual(sites.items.map(site => [site.code, site.tenant_id]), [['site', id]]);
  const assets = await (await imported('/inventory/assets')).json();
  assert.equal(assets.items.length, 2);
  const markers = await (await imported('/inventory/sites/map?west=-47&south=-24&east=-46&north=-23')).json();
  assert.deepEqual(markers.items.map(site => [site.code, site.latitude, site.longitude]), [['site', -23.55, -46.63]]);
  assert.equal((await imported('/logout', { data: {} })).status, 204);
  console.log('Console autenticou a conta migrada e consultou inventário e mapa importados.');
  process.exit(0);
}

if (process.argv.includes('--site-writes')) {
  const a = client();
  const b = client();
  const viewer = client();
  const global = client();
  const loginAs = (session, email, password) => session('/login', { data: { email, password } });
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const path = '/inventory/sites';
  assert.equal((await (await a('/status')).json()).site_writes, true);
  assert.equal((await a(path, { data: {}, headers: scope(tenantA) })).status, 401);
  assert.equal((await loginAs(a, 'operator-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await loginAs(b, 'operator-b-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await loginAs(viewer, 'viewer-auth@example.invalid', 'viewer-ci-fixture-only')).status, 204);

  const payload = { code: 'pilot-edit', name: 'Site do piloto', cep: '01234-567' };
  assert.equal((await a(path, { data: payload })).status, 422);
  assert.equal((await a(path, { data: { ...payload, tenant_id: tenantB }, headers: scope(tenantA) })).status, 422);
  assert.equal((await viewer(path, { data: payload, headers: scope(tenantA) })).status, 403);
  const ownConcessions = await (await a('/inventory/concessions')).json();
  const foreignConcessions = await (await b('/inventory/concessions')).json();
  assert.equal((await a(path, {
    data: { ...payload, concession_id: foreignConcessions.items[0].id }, headers: scope(tenantA),
  })).status, 422);

  const created = await a(path, {
    data: { ...payload, concession_id: ownConcessions.items[0].id }, headers: scope(tenantA),
  });
  assert.equal(created.status, 201);
  const site = await created.json();
  assert.equal(site.code, 'PILOT-EDIT');
  assert.equal(site.tenant_id, tenantA);
  assert.equal(site.cep, '01234567');
  assert.equal((await a(path, { data: payload, headers: scope(tenantA) })).status, 409);
  const edit = path + '/' + site.id;
  const patch = (session, tenant, data, headers = {}) =>
    session(edit, { method: 'PATCH', data, headers: { ...scope(tenant), ...headers } });
  assert.equal((await patch(b, tenantB, { name: 'Outro tenant' })).status, 404);
  assert.equal((await patch(viewer, tenantA, { name: 'Leitor' })).status, 403);
  assert.equal((await patch(a, tenantA, { name: 'Origem externa' }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await patch(a, tenantA, { name: 'Formato incorreto' }, { 'Content-Type': 'text/plain' })).status, 403);
  const updated = await patch(a, tenantA, { name: 'Site do piloto atualizado' });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).concession_id, ownConcessions.items[0].id);

  const location = edit + '/verify-coords';
  const coords = { latitude: -18.5, longitude: -43.25 };
  const verify = (session, tenant, data) => session(location, { method: 'PATCH', data, headers: scope(tenant) });
  const viewport = path + '/map?west=-44&south=-19&east=-43&north=-18';
  const before = await (await a(viewport)).json();
  assert.ok(!before.items.some(marker => marker.id === site.id));
  assert.equal((await a(location, { method: 'PATCH', data: coords })).status, 422);
  assert.equal((await verify(viewer, tenantA, coords)).status, 403);
  assert.equal((await verify(b, tenantB, coords)).status, 404);
  assert.equal((await verify(a, tenantA, { ...coords, latitude: -91 })).status, 422);
  const verified = await verify(a, tenantA, coords);
  assert.equal(verified.status, 200);
  const point = await verified.json();
  assert.equal(point.coord_precision, 'manual_verificada');
  assert.equal(point.coord_verified, true);
  const mapA = await (await a(viewport)).json();
  const marker = mapA.items.find(item => item.id === site.id);
  assert.equal(marker?.latitude, coords.latitude);
  assert.equal(marker?.longitude, coords.longitude);
  const mapB = await (await b(viewport)).json();
  assert.ok(!mapB.items.some(item => item.id === site.id));

  assert.equal((await loginAs(global, 'global-auth@example.invalid', 'global-ci-fixture-only')).status, 204);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantA } })).status, 200);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await global(path, {
    data: { code: 'stale-tab', name: 'Formulário de outro tenant' }, headers: scope(tenantA),
  })).status, 409);
  assert.equal((await verify(global, tenantA, { latitude: 0, longitude: 0 })).status, 409);
  const readB = await (await b(path)).json();
  assert.ok(!readB.items.some(item => item.code === 'STALE-TAB' || item.id === site.id));
  const readA = await (await a(path)).json();
  const loaded = readA.items.find(item => item.id === site.id);
  assert.equal(loaded?.name, 'Site do piloto atualizado');
  assert.equal(loaded?.latitude, coords.latitude);
  for (const session of [a, b, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Cadastro, edição e coordenadas no mapa verificados com proteção por tenant.');
  process.exit(0);
}

if (process.argv.includes('--asset-writes')) {
  const a = client();
  const b = client();
  const viewer = client();
  const admin = client();
  const path = '/inventory/assets';
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, email, password) => session('/login', { data: { email, password } });
  assert.equal((await (await a('/status')).json()).asset_writes, true);
  assert.equal((await a(path, { data: {}, headers: scope(tenantA) })).status, 401);
  assert.equal((await login(a, 'operator-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(b, 'operator-b-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(viewer, 'viewer-auth@example.invalid', 'viewer-ci-fixture-only')).status, 204);
  const read = async (session, route) => (await (await session(route)).json()).items;
  const siteA = (await read(a, '/inventory/sites')).find(site => site.code === 'a-1');
  const siteB = (await read(b, '/inventory/sites')).find(site => site.code === 'b-1');
  const categories = await read(a, '/inventory/asset-categories');
  const category = categories.find(item => item.code === 'link__ptico');
  const nextCategory = categories.find(item => item.code === 'sensor');
  const foreignCategory = (await read(b, '/inventory/asset-categories'))[0];
  const payload = {
    name: 'Ativo físico do piloto', hostname: 'fixture-pilot', georeference_mode: 'required',
    site_id: siteA.id, category_id: category.id,
  };
  assert.equal((await a(path, { data: payload })).status, 422);
  assert.equal((await viewer(path, { data: payload, headers: scope(tenantA) })).status, 403);
  for (const changes of [{ site_id: null }, { site_id: siteB.id }, { category_id: foreignCategory.id }]) {
    assert.equal((await a(path, { data: { ...payload, ...changes }, headers: scope(tenantA) })).status, 422);
  }
  const created = await a(path, { data: payload, headers: scope(tenantA) });
  assert.equal(created.status, 201);
  const asset = await created.json();
  assert.equal(asset.tenant_id, tenantA);
  assert.equal(asset.asset_type_code, category.code);
  assert.equal(asset.domain, category.domain);
  assert.equal(asset.operational_state, 'NO_DATA');
  const patch = (session, tenant, data) => session(path + '/' + asset.id, {
    method: 'PATCH', data, headers: scope(tenant),
  });
  assert.equal((await patch(b, tenantB, { name: 'Outro tenant' })).status, 404);
  assert.equal((await patch(viewer, tenantA, { name: 'Leitor' })).status, 403);
  const updated = await patch(a, tenantA, {
    name: 'Ativo do piloto atualizado', site_id: null, georeference_mode: 'none', category_id: nextCategory.id,
  });
  assert.equal(updated.status, 200);
  const changed = await updated.json();
  assert.equal(changed.site_id, null);
  assert.equal(changed.georeference_mode, 'none');
  assert.equal(changed.asset_type_code, nextCategory.code);
  assert.equal(changed.domain, nextCategory.domain);
  assert.equal((await a(path, {
    data: { name: 'Ativo lógico do piloto', georeference_mode: 'none' }, headers: scope(tenantA),
  })).status, 201);
  assert.equal((await login(admin, 'global-auth@example.invalid', 'global-ci-fixture-only')).status, 204);
  assert.equal((await admin('/switch-tenant', { data: { tenant_id: tenantA } })).status, 200);
  assert.equal((await admin('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await admin(path, { data: { name: 'Ativo em aba desatualizada' }, headers: scope(tenantA) })).status, 409);
  assert.ok(!(await read(b, path)).some(item => item.id === asset.id || item.name === 'Ativo em aba desatualizada'));
  assert.ok((await read(a, path)).some(item => item.id === asset.id && item.name === changed.name));
  for (const session of [a, b, viewer, admin]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Cadastro e edição de ativos verificados por HTTPS com vínculos, georreferenciamento e isolamento por tenant.');
  process.exit(0);
}

if (process.argv.includes('--service-writes')) {
  const a = client();
  const b = client();
  const viewer = client();
  const global = client();
  const path = '/inventory/services';
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, email, password) => session('/login', { data: { email, password } });
  assert.equal((await (await a('/status')).json()).service_writes, true);
  assert.equal((await a(path, { data: {}, headers: scope(tenantA) })).status, 401);
  assert.equal((await login(a, 'operator-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(b, 'operator-b-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(viewer, 'viewer-auth@example.invalid', 'viewer-ci-fixture-only')).status, 204);
  const fields = { code: 'pilot service', name: 'Serviço do piloto', sla_target_pct: 99.95, owner_team: 'NOC' };
  assert.equal((await viewer(path, { data: fields, headers: scope(tenantA) })).status, 403);
  assert.equal((await a(path, { data: fields })).status, 422);
  for (const invalid of [-1, 100.1, '99.95', true]) {
    assert.equal((await a(path, { data: { ...fields, sla_target_pct: invalid }, headers: scope(tenantA) })).status, 422);
  }
  const created = await a(path, { data: fields, headers: scope(tenantA) });
  assert.equal(created.status, 201);
  const service = await created.json();
  assert.equal(service.code, 'PILOT_SERVICE');
  assert.equal(service.sla_target_pct, 99.95);
  assert.equal(service.operational_state, 'NO_DATA');
  assert.equal(service.tenant_id, tenantA);
  assert.equal((await a(path, { data: fields, headers: scope(tenantA) })).status, 409);
  const other = await b(path, { data: { ...fields, sla_target_pct: 0 }, headers: scope(tenantB) });
  assert.equal(other.status, 201);
  assert.equal((await other.json()).sla_target_pct, 0);

  const patch = (session, tenant, data) => session(path + '/' + service.id, {
    method: 'PATCH', headers: scope(tenant), data,
  });
  assert.equal((await patch(b, tenantB, { name: 'Outro tenant' })).status, 404);
  assert.equal((await patch(viewer, tenantA, { name: 'Leitor' })).status, 403);
  assert.equal((await patch(a, tenantA, { code: 'NOVO' })).status, 422);
  const changed = await patch(a, tenantA, { name: 'Serviço do piloto atualizado', sla_target_pct: null });
  assert.equal(changed.status, 200);
  const edited = await changed.json();
  assert.equal(edited.sla_target_pct, null);
  assert.equal(edited.owner_team, 'NOC');

  assert.equal((await login(global, 'global-auth@example.invalid', 'global-ci-fixture-only')).status, 204);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantA } })).status, 200);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await global(path, { data: { ...fields, code: 'stale' }, headers: scope(tenantA) })).status, 409);
  const listA = (await (await a(path)).json()).items;
  const listB = (await (await b(path)).json()).items;
  assert.deepEqual(listA.find(row => row.id === service.id), edited);
  assert.ok(!listB.some(row => row.id === service.id || row.code === 'STALE'));
  for (const session of [a, b, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Cadastro e edição de serviços verificados por HTTPS com SLA e isolamento por tenant.');
  process.exit(0);
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
