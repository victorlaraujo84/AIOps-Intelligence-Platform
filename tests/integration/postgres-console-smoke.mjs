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
    enabled: true, pilot_only: true, site_writes: false, asset_writes: false, service_writes: false, user_admin: false, tenant_creation: false,
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

if (process.argv.includes('--dependency-writes')) {
  const a = client();
  const b = client();
  const viewer = client();
  const admin = client();
  const login = (session, email, password) => session('/login', { data: { email, password } });
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const read = async (session, path) => (await (await session(path)).json()).items;
  assert.equal((await login(a, 'operator-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(b, 'operator-b-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(viewer, 'viewer-auth@example.invalid', 'viewer-ci-fixture-only')).status, 204);
  const services = '/inventory/services';
  const current = (await read(a, services)).find(row => row.code === 'PILOT_SERVICE');
  const upstream = (await read(a, services)).find(row => row.code === 'RUNTIME_SERVICE');
  const foreign = (await read(b, services)).find(row => row.code === 'PILOT_SERVICE');
  const asset = (await read(a, '/inventory/assets')).find(row => row.name === 'Ativo A');
  const foreignAsset = (await read(b, '/inventory/assets')).find(row => row.name === 'Ativo B');
  const path = services + '/' + current.id + '/dependencies';
  const add = (session, tenant, data) => session(path, { data, headers: scope(tenant) });
  assert.equal((await b(path)).status, 404);
  assert.equal((await viewer(path)).status, 200);
  assert.equal((await add(viewer, tenantA, { asset_id: asset.id })).status, 403);
  assert.equal((await a(path, { data: { asset_id: asset.id } })).status, 422);
  assert.equal((await add(a, tenantA, { asset_id: foreignAsset.id })).status, 422);
  assert.equal((await add(a, tenantA, { upstream_service_id: foreign.id })).status, 422);
  assert.equal((await add(a, tenantA, { asset_id: asset.id, weight: 0 })).status, 422);
  const linked = await add(a, tenantA, { asset_id: asset.id, dependency_role: 'redundant', weight: 2.5 });
  assert.equal(linked.status, 201);
  const link = await linked.json();
  const upstreamLink = await add(a, tenantA, { upstream_service_id: upstream.id });
  assert.equal(upstreamLink.status, 201);
  assert.equal((await a(services + '/' + upstream.id + '/dependencies', {
    data: { upstream_service_id: current.id }, headers: scope(tenantA),
  })).status, 409);
  const dependencies = await read(viewer, path);
  assert.ok(dependencies.some(row => row.id === link.id && row.asset_name === 'Ativo A' && row.weight === 2.5));
  assert.ok(dependencies.some(row => row.upstream_service_id === upstream.id));

  const remove = (session, tenant, extra = {}) => session(path + '/' + link.id, {
    method: 'DELETE', data: {}, headers: { ...scope(tenant), ...extra },
  });
  assert.equal((await remove(viewer, tenantA)).status, 403);
  assert.equal((await remove(b, tenantB)).status, 404);
  assert.equal((await remove(a, tenantA, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await login(admin, 'global-auth@example.invalid', 'global-ci-fixture-only')).status, 204);
  assert.equal((await admin('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await remove(admin, tenantA)).status, 409);
  assert.equal((await remove(a, tenantA)).status, 204);
  assert.ok(!(await read(a, path)).some(row => row.id === link.id));
  for (const session of [a, b, viewer, admin]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Dependências listadas, criadas e removidas por HTTPS com isolamento e bloqueio de ciclos.');
  process.exit(0);
}

if (process.argv.includes('--topology-writes')) {
  const a = client();
  const b = client();
  const viewer = client();
  const admin = client();
  const path = '/inventory/topology/edges';
  const login = (session, email, password) => session('/login', { data: { email, password } });
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const list = async (session, path) => {
    const response = await session(path);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await a(path)).status, 401);
  assert.equal((await login(a, 'operator-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(b, 'operator-b-auth@example.invalid', 'operator-ci-fixture-only')).status, 204);
  assert.equal((await login(viewer, 'viewer-auth@example.invalid', 'viewer-ci-fixture-only')).status, 204);
  const own = (await list(a, '/inventory/assets')).items;
  const foreign = (await list(b, '/inventory/assets')).items.find(row => row.name === 'Ativo B');
  const source = own.find(row => row.name === 'Ativo A');
  const target = own.find(row => row.name === 'Ativo Runtime');
  const data = {
    source_asset_id: source.id, target_asset_id: target.id, link_type: 'piloto-https',
    provider_name: 'Operadora de teste', capacity_mbps: 0, is_redundant: true,
  };
  const add = (session, payload = data) => session(path, { data: payload, headers: scope(tenantA) });
  assert.equal((await a(path, { data })).status, 422);
  assert.equal((await add(viewer)).status, 403);
  assert.equal((await add(a, { ...data, target_asset_id: foreign.id })).status, 422);
  assert.equal((await add(a, { ...data, capacity_mbps: -1 })).status, 422);
  const created = await add(a);
  assert.equal(created.status, 201);
  const edge = await created.json();
  assert.equal(edge.tenant_id, tenantA);
  assert.equal((await add(a)).status, 409);
  assert.equal((await add(a, { ...data, source_asset_id: target.id, target_asset_id: source.id })).status, 409);
  const { items } = await list(viewer, path + '?tenant_id=' + tenantB);
  const row = items.find(item => item.id === edge.id);
  assert.deepEqual(
    [row.source_asset_name, row.target_asset_name, row.provider_name, row.capacity_mbps, row.is_redundant],
    [source.name, target.name, data.provider_name, 0, true],
  );
  assert.ok(!(await list(b, path)).items.some(item => item.id === edge.id));
  const page = await list(viewer, path + '?limit=1');
  assert.ok(page.next_after);
  assert.notEqual((await list(viewer, path + '?limit=1&after=' + page.next_after)).items[0].id, page.items[0].id);

  const remove = (session, tenant, extra = {}) => session(path + '/' + edge.id, {
    method: 'DELETE', data: {}, headers: { ...scope(tenant), ...extra },
  });
  assert.equal((await remove(viewer, tenantA)).status, 403);
  assert.equal((await remove(b, tenantB)).status, 404);
  assert.equal((await remove(a, tenantA, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await login(admin, 'global-auth@example.invalid', 'global-ci-fixture-only')).status, 204);
  assert.equal((await admin('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await remove(admin, tenantA)).status, 409);
  assert.equal((await remove(a, tenantA)).status, 204);
  assert.equal((await remove(a, tenantA)).status, 404);
  assert.ok(!(await list(viewer, path)).items.some(item => item.id === edge.id));
  for (const session of [a, b, viewer, admin]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Enlaces topológicos consultados, cadastrados e removidos por HTTPS com isolamento por tenant.');
  process.exit(0);
}

if (process.argv.includes('--tenant-users')) {
  const a = client();
  const b = client();
  const globalAdmin = client();
  const operator = client();
  const viewer = client();
  const anotherSession = client();
  const path = '/tenant-users';
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, email, password) => session('/login', { data: { email, password } });
  const list = async (session, tenant, query = '') => {
    const response = await session(path + query, { headers: scope(tenant) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const loginFixture = (session, name, role = name) =>
    login(session, name + '-auth@example.invalid', role + '-ci-fixture-only');

  assert.equal((await a(path, { headers: scope(tenantA) })).status, 401);
  assert.equal((await loginFixture(a, 'admin')).status, 204);
  assert.equal((await loginFixture(b, 'admin-b', 'admin')).status, 204);
  assert.equal((await loginFixture(globalAdmin, 'global')).status, 204);
  assert.equal((await loginFixture(operator, 'operator')).status, 204);
  assert.equal((await a(path)).status, 422);
  assert.equal((await operator(path, { headers: scope(tenantA) })).status, 403);
  assert.equal((await globalAdmin(path, { headers: scope(tenantA) })).status, 409);
  assert.equal((await globalAdmin('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await globalAdmin(path, { headers: scope(tenantA) })).status, 409);
  assert.ok((await list(globalAdmin, tenantB)).items.some(row => row.email === 'admin-b-auth@example.invalid'));
  assert.equal((await b(path, { headers: scope(tenantA) })).status, 409);
  const { items, next_after: after } = await list(a, tenantA, '?limit=1');
  assert.ok(after);
  assert.notEqual((await list(a, tenantA, '?limit=1&after=' + after)).items[0].id, items[0].id);

  const email = 'tenant-user-smoke@example.invalid';
  const password = 'viewer-created-smoke-only';
  const data = { email: '  ' + email.toUpperCase() + '  ', full_name: 'Leitor cadastrado', password };
  const add = (session, tenant, payload = data) => session(path, { data: payload, headers: scope(tenant) });
  assert.equal((await add(operator, tenantA)).status, 403);
  assert.equal((await add(a, tenantA, { ...data, tenant_id: tenantB })).status, 422);
  assert.equal((await add(a, tenantA, { ...data, role: 'super_admin' })).status, 422);
  assert.equal((await add(a, tenantA, { ...data, password: '123' })).status, 422);
  const created = await add(a, tenantA);
  assert.equal(created.status, 201);
  const { id } = await created.json();
  assert.equal((await add(a, tenantA)).status, 409);
  const own = (await list(a, tenantA, '?tenant_id=' + tenantB)).items;
  assert.deepEqual(own.find(row => row.id === id), {
    id, email, full_name: data.full_name, role: 'tenant_viewer', is_active: true,
  });
  assert.ok(!(await list(b, tenantB)).items.some(row => row.id === id));

  const change = (session, tenant, userId, active, extra = {}) => session(path + '/' + userId + '/status', {
    method: 'PATCH', data: { is_active: active }, headers: { ...scope(tenant), ...extra },
  });
  assert.equal((await login(viewer, email, password)).status, 204);
  assert.equal((await login(anotherSession, email, password)).status, 204);
  assert.equal((await viewer(path, { headers: scope(tenantA) })).status, 403);
  assert.equal((await change(b, tenantB, id, false)).status, 404);
  assert.equal((await change(a, tenantA, id, false, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const ownAdmin = own.find(row => row.email === 'admin-auth@example.invalid');
  assert.equal((await change(a, tenantA, ownAdmin.id, false)).status, 422);
  const disabled = await change(a, tenantA, id, false);
  assert.equal(disabled.status, 200);
  assert.deepEqual(await disabled.json(), { id, is_active: false });
  assert.equal((await change(a, tenantA, id, false)).status, 200);
  for (const stale of [viewer, anotherSession]) assert.equal((await stale('/me')).status, 401);
  assert.equal((await login(client(), email, password)).status, 401);
  assert.equal((await change(a, tenantA, id, true)).status, 200);
  for (const stale of [viewer, anotherSession]) assert.equal((await stale('/me')).status, 401);
  const relogged = client();
  assert.equal((await login(relogged, email, password)).status, 204);
  for (const session of [a, b, globalAdmin, operator, relogged]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Administração de usuários validada por HTTPS com papéis, tenant ativo, auditoria verificável e revogação de sessões.');
  process.exit(0);
}

if (process.argv.includes('--create-tenants')) {
  const globalAdmin = client();
  const secondSession = client();
  const tenantAdmin = client();
  const path = '/tenants';
  const login = (session, kind) => session('/login', {
    data: { email: kind + '-auth@example.invalid', password: kind + '-ci-fixture-only' },
  });
  const add = (session, data, headers) => session(path, { data, headers });
  const get = async (session, path) => {
    const response = await session(path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const payload = { name: '  Tenant Novo CI  ', document: '  TESTE-020  ' };
  assert.equal((await add(globalAdmin, payload)).status, 401);
  assert.equal((await login(tenantAdmin, 'admin')).status, 204);
  assert.equal((await add(tenantAdmin, payload)).status, 403);
  assert.equal((await login(globalAdmin, 'global')).status, 204);
  assert.equal((await get(globalAdmin, '/me')).active_tenant_id, null);
  assert.equal((await add(globalAdmin, payload, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await add(globalAdmin, { ...payload, slug: '!!!' })).status, 422);
  assert.equal((await add(globalAdmin, { ...payload, status: 'suspended' })).status, 422);

  const response = await add(globalAdmin, payload);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const first = await response.json();
  assert.deepEqual(first, { id: first.id, name: 'Tenant Novo CI', slug: 'tenant-novo-ci', active_tenant_id: first.id });
  assert.equal((await get(globalAdmin, '/me')).active_tenant_id, first.id);
  assert.ok((await get(globalAdmin, path)).items.some(item => item.id === first.id));
  assert.deepEqual((await get(tenantAdmin, path)).items.map(item => item.id), [tenantA]);
  assert.equal((await add(globalAdmin, { name: 'Repetido', slug: 'TENANT__NOVO--CI' })).status, 409);

  const locations = (await get(globalAdmin, '/inventory/locality-types')).items;
  const categories = (await get(globalAdmin, '/inventory/asset-categories')).items;
  assert.equal(locations.length, 9);
  assert.ok(locations.some(item => item.code.toUpperCase() === 'DATACENTER_CLOUD'));
  assert.equal(categories.length, 14);
  assert.ok(categories.some(item => item.code === 'weather_station'));
  for (const resource of ['sites', 'assets', 'services']) {
    assert.deepEqual((await get(globalAdmin, '/inventory/' + resource)).items, []);
  }

  assert.equal((await login(secondSession, 'global')).status, 204);
  assert.equal((await secondSession('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  const duplicate = { name: 'Tenant Concorrente', slug: 'tenant-ci-concorrente' };
  const results = await Promise.all([add(globalAdmin, duplicate), add(secondSession, duplicate)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const active = [first.id, tenantB];
  const winner = results.findIndex(result => result.status === 201);
  assert.equal((await results[winner].json()).active_tenant_id, active[winner]);
  assert.equal((await get(globalAdmin, '/me')).active_tenant_id, first.id);
  assert.equal((await get(secondSession, '/me')).active_tenant_id, tenantB);
  for (const session of [globalAdmin, secondSession, tenantAdmin]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Cadastro de tenants validado por HTTPS com permissões, catálogos, sessão e conflito de identificador.');
  process.exit(0);
}

if (process.argv.includes('--catalog-writes')) {
  const a = client();
  const b = client();
  const viewer = client();
  const global = client();
  const login = (session, name, password) => session('/login', {
    data: { email: name + '-auth@example.invalid', password: password + '-ci-fixture-only' },
  });
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const put = (session, path, tenant, data, headers = {}) =>
    session('/inventory/' + path, { data, headers: { ...scope(tenant), ...headers } });
  assert.equal((await login(a, 'operator', 'operator')).status, 204);
  assert.equal((await login(b, 'operator-b', 'operator')).status, 204);
  assert.equal((await login(viewer, 'viewer', 'viewer')).status, 204);
  assert.equal((await login(global, 'global', 'global')).status, 204);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  const specs = [
    ['asset-categories', { code: ' Catalogo Portal ', label: 'Categoria Portal', domain: 'ti' }, 'catalogo_portal'],
    ['concessions', { code: ' catalogo-portal ', name: 'Concessão Portal', region: 'Sul' }, 'CATALOGO-PORTAL'],
    ['locality-types', { code: ' Catalogo Portal ', label: 'Localidade Portal', description: 'Descrição' }, 'CATALOGO_PORTAL'],
  ];
  const ids = new Map();
  for (const [resource, data, code] of specs) {
    const path = '/inventory/' + resource;
    assert.equal((await put(client(), resource, tenantA, data)).status, 401);
    assert.equal((await a(path, { data })).status, 422);
    assert.equal((await put(viewer, resource, tenantA, data)).status, 403);
    assert.equal((await put(global, resource, tenantA, data)).status, 409);
    assert.equal((await put(a, resource, tenantA, { ...data, tenant_id: tenantB })).status, 422);
    assert.equal((await put(a, resource, tenantA, data, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const response = await put(a, resource, tenantA, data);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const item = await response.json();
    assert.equal(item.code, code);
    assert.equal(item.tenant_id, tenantA);
    for (const [key, value] of Object.entries(data)) {
      if (key !== 'code') assert.equal(item[key], value);
    }
    ids.set(resource, item.id);
    assert.equal((await put(a, resource, tenantA, { ...data, code })).status, 409);
    assert.ok((await (await viewer(path)).json()).items.some(row => row.id === item.id));
    assert.ok(!(await (await b(path)).json()).items.some(row => row.id === item.id));
  }

  assert.equal((await put(b, 'asset-categories', tenantB, specs[0][1])).status, 201);
  const site = await put(a, 'sites', tenantA, {
    code: 'CATALOG-LINK', name: 'Site com catálogos novos',
    concession_id: ids.get('concessions'), locality_type_id: ids.get('locality-types'),
  });
  assert.equal(site.status, 201);
  const savedSite = await site.json();
  assert.deepEqual([savedSite.concession_id, savedSite.locality_type_id],
    [ids.get('concessions'), ids.get('locality-types')]);
  const asset = await put(a, 'assets', tenantA, {
    name: 'Ativo com categoria nova', site_id: savedSite.id, category_id: ids.get('asset-categories'),
  });
  assert.equal(asset.status, 201);
  const savedAsset = await asset.json();
  assert.deepEqual([savedAsset.category_id, savedAsset.domain], [ids.get('asset-categories'), 'ti']);
  for (const session of [a, b, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Cadastros do catálogo, isolamento e vínculos de sites e ativos verificados por HTTPS.');
  process.exit(0);
}

if (process.argv.includes('--concession-delete')) {
  const a = client();
  const b = client();
  const viewer = client();
  const operator = client();
  const global = client();
  const login = (session, name, password) => session('/login', {
    data: { email: name + '-auth@example.invalid', password: password + '-ci-fixture-only' },
  });
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const path = '/inventory/concessions';
  const create = async (session, tenant, path, data) => {
    const response = await session(path, { data, headers: scope(tenant) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const list = async (session, path) => {
    const response = await session(path);
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  assert.equal((await login(a, 'admin', 'admin')).status, 204);
  assert.equal((await login(b, 'admin-b', 'admin')).status, 204);
  assert.equal((await login(operator, 'operator', 'operator')).status, 204);
  assert.equal((await login(viewer, 'viewer', 'viewer')).status, 204);
  assert.equal((await login(global, 'global', 'global')).status, 204);

  const data = { code: 'CONCESSION-DELETE', name: 'Concessão para excluir' };
  const concession = await create(a, tenantA, path, data);
  const other = await create(b, tenantB, path, data);
  const type = await create(a, tenantA, '/inventory/locality-types', { code: 'DELETE_LINK', label: 'Localidade do vínculo' });
  const site = await create(a, tenantA, '/inventory/sites', {
    code: 'CONCESSION-DELETE-SITE', name: 'Site permanece', concession_id: concession.id, locality_type_id: type.id,
  });
  const otherSite = await create(b, tenantB, '/inventory/sites', {
    code: 'CONCESSION-DELETE-SITE', name: 'Site outro tenant', concession_id: other.id,
  });
  const before = (await list(viewer, '/inventory/sites')).find(row => row.id === site.id);
  assert.equal(before.concession_id, concession.id);
  assert.equal(before.locality_type_id, type.id);
  const remove = (session, headers) => session(path + '/' + concession.id, { method: 'DELETE', data: {}, headers });

  assert.equal((await remove(client(), scope(tenantA))).status, 401);
  assert.equal((await remove(a)).status, 422);
  assert.equal((await remove(a, { ...scope(tenantA), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await remove(operator, scope(tenantA))).status, 403);
  assert.equal((await remove(viewer, scope(tenantA))).status, 403);
  assert.equal((await remove(b, scope(tenantB))).status, 404);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await remove(global, scope(tenantA))).status, 409);

  const results = await Promise.all([remove(a, scope(tenantA)), remove(a, scope(tenantA))]);
  assert.deepEqual(results.map(response => response.status).sort(), [204, 404]);
  assert.equal(await results.find(response => response.status === 204).text(), '');
  assert.ok(!(await list(viewer, path)).some(row => row.id === concession.id));
  const after = (await list(viewer, '/inventory/sites')).find(row => row.id === site.id);
  assert.deepEqual(after, { ...before, concession_id: null });
  assert.ok((await list(b, path)).some(row => row.id === other.id));
  assert.equal((await list(b, '/inventory/sites')).find(row => row.id === otherSite.id).concession_id, other.id);

  for (const session of [a, b, operator, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Remoção de concessão por HTTPS, RBAC e desvinculação do site verificados.');
  process.exit(0);
}

if (process.argv.includes('--site-delete')) {
  const admin = client();
  const other = client();
  const viewer = client();
  const operator = client();
  const global = client();
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, name, password = name) => session('/login', {
    data: { email: name + '-auth@example.invalid', password: password + '-ci-fixture-only' },
  });
  const create = async (session, tenant, path, data) => {
    const response = await session(path, { data, headers: scope(tenant) });
    assert.equal(response.status, 201);
    return response.json();
  };
  const list = async (session, path) => {
    const response = await session(path);
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  assert.equal((await login(admin, 'admin')).status, 204);
  assert.equal((await login(other, 'admin-b', 'admin')).status, 204);
  assert.equal((await login(operator, 'operator')).status, 204);
  assert.equal((await login(viewer, 'viewer')).status, 204);
  assert.equal((await login(global, 'global')).status, 204);

  const sites = '/inventory/sites';
  const assets = '/inventory/assets';
  const site = (await list(viewer, sites)).find(row => row.code === 'SITE-DELETE-CHECK');
  assert.ok(site, 'Carregue a fixture SITE-DELETE-CHECK antes deste teste.');
  const foreign = await create(other, tenantB, sites, { code: site.code, name: 'Site outro tenant' });
  const target = sites + '/' + site.id;
  assert.equal((await admin(target + '/verify-coords', {
    method: 'PATCH', data: { latitude: -17.5, longitude: -49.25 }, headers: scope(tenantA),
  })).status, 200);
  const map = sites + '/map?west=-50&south=-18&east=-49&north=-17';
  assert.ok((await list(viewer, map)).some(row => row.id === site.id));
  const linked = await create(admin, tenantA, assets, {
    name: 'Ativo mantido após exclusão', site_id: site.id, georeference_mode: 'required',
  });
  assert.equal(linked.site_id, site.id);

  const remove = (session, headers) => session(target, { method: 'DELETE', data: {}, headers });
  assert.equal((await remove(client(), scope(tenantA))).status, 401);
  assert.equal((await remove(admin)).status, 422);
  assert.equal((await remove(admin, { ...scope(tenantA), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await remove(operator, scope(tenantA))).status, 403);
  assert.equal((await remove(viewer, scope(tenantA))).status, 403);
  assert.equal((await remove(other, scope(tenantB))).status, 404);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await remove(global, scope(tenantA))).status, 409);

  const results = await Promise.all([remove(admin, scope(tenantA)), remove(admin, scope(tenantA))]);
  assert.deepEqual(results.map(response => response.status).sort(), [204, 404]);
  assert.equal(await results.find(response => response.status === 204).text(), '');
  assert.ok(!(await list(viewer, sites)).some(row => row.id === site.id));
  assert.ok(!(await list(viewer, map)).some(row => row.id === site.id));
  assert.deepEqual((await list(viewer, assets)).find(row => row.id === linked.id), { ...linked, site_id: null });
  assert.ok((await list(other, sites)).some(row => row.id === foreign.id));
  for (const session of [admin, other, operator, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Exclusão de site, mapa, papéis, isolamento e preservação do ativo verificados por HTTPS.');
  process.exit(0);
}

if (process.argv.includes('--asset-delete')) {
  const admin = client();
  const other = client();
  const viewer = client();
  const operator = client();
  const global = client();
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, name, password = name) => session('/login', {
    data: { email: name + '-auth@example.invalid', password: password + '-ci-fixture-only' },
  });
  const list = async (session, path) => {
    const response = await session(path);
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  assert.equal((await login(admin, 'admin')).status, 204);
  assert.equal((await login(other, 'admin-b', 'admin')).status, 204);
  assert.equal((await login(operator, 'operator')).status, 204);
  assert.equal((await login(viewer, 'viewer')).status, 204);
  assert.equal((await login(global, 'global')).status, 204);

  const assets = '/inventory/assets';
  const own = await list(viewer, assets);
  const asset = own.find(row => row.name === 'Ativo para excluir CI');
  const child = own.find(row => row.name === 'Ativo filho a preservar CI');
  const foreign = (await list(other, assets)).find(row => row.name === 'Ativo B');
  const service = (await list(viewer, '/inventory/services')).find(row => row.code === 'ASSET_DELETE_LINK');
  assert.ok(asset && child && foreign && service, 'Carregue as fixtures de exclusão de ativos antes deste teste.');

  const edges = '/inventory/topology/edges';
  const dependencies = '/inventory/services/' + service.id + '/dependencies';
  const fixtureEdges = (await list(viewer, edges)).filter(row => row.link_type === 'asset-delete-ci');
  assert.equal(fixtureEdges.length, 3);
  const before = await list(viewer, dependencies);
  assert.deepEqual(before.map(row => row.asset_id).sort(), [asset.id, child.id].sort());
  const target = assets + '/' + asset.id;
  const remove = (session, headers) => session(target, { method: 'DELETE', data: {}, headers });
  assert.equal((await remove(client(), scope(tenantA))).status, 401);
  assert.equal((await remove(admin)).status, 422);
  assert.equal((await remove(admin, { ...scope(tenantA), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await remove(operator, scope(tenantA))).status, 403);
  assert.equal((await remove(viewer, scope(tenantA))).status, 403);
  assert.equal((await remove(other, scope(tenantB))).status, 404);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await remove(global, scope(tenantA))).status, 409);

  const results = await Promise.all([remove(admin, scope(tenantA)), remove(admin, scope(tenantA))]);
  assert.deepEqual(results.map(response => response.status).sort(), [204, 404]);
  assert.equal(await results.find(response => response.status === 204).text(), '');
  const after = await list(viewer, assets);
  assert.ok(!after.some(row => row.id === asset.id));
  assert.deepEqual(after.find(row => row.id === child.id), child);
  assert.deepEqual((await list(viewer, edges)).filter(row => row.link_type === 'asset-delete-ci'),
    fixtureEdges.filter(row => row.source_asset_id !== asset.id && row.target_asset_id !== asset.id));
  assert.deepEqual(await list(viewer, dependencies), before.filter(row => row.asset_id !== asset.id));
  assert.deepEqual((await list(other, assets)).find(row => row.id === foreign.id), foreign);

  for (const session of [admin, other, operator, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Exclusão de ativo, enlaces e dependências seletivos, papéis e isolamento verificados por HTTPS.');
  process.exit(0);
}

if (process.argv.includes('--service-delete')) {
  const admin = client();
  const other = client();
  const viewer = client();
  const operator = client();
  const global = client();
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, name, password = name) => session('/login', {
    data: { email: name + '-auth@example.invalid', password: password + '-ci-fixture-only' },
  });
  const list = async (session, path) => {
    const response = await session(path);
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  assert.equal((await login(admin, 'admin')).status, 204);
  assert.equal((await login(other, 'admin-b', 'admin')).status, 204);
  assert.equal((await login(operator, 'operator')).status, 204);
  assert.equal((await login(viewer, 'viewer')).status, 204);
  assert.equal((await login(global, 'global')).status, 204);

  const services = '/inventory/services';
  const own = await list(viewer, services);
  const removed = own.find(row => row.code === 'SERVICE_DELETE_CHECK');
  const consumer = own.find(row => row.code === 'SERVICE_DELETE_CONSUMER');
  const upstream = own.find(row => row.code === 'SERVICE_DELETE_UPSTREAM');
  assert.ok(removed && consumer && upstream, 'Carregue as fixtures de exclusão de serviços antes deste teste.');
  const foreign = await list(other, services);
  assert.ok(foreign.length);
  const target = services + '/' + removed.id;
  const consumerDependencies = services + '/' + consumer.id + '/dependencies';
  const before = await list(viewer, consumerDependencies);
  assert.deepEqual(before.map(row => row.upstream_service_id).sort(), [removed.id, upstream.id].sort());
  const outgoing = await list(viewer, target + '/dependencies');
  assert.equal(outgoing.length, 2);
  const assetId = outgoing.find(row => row.asset_id)?.asset_id;
  assert.ok(assetId);
  assert.ok(outgoing.some(row => row.upstream_service_id === upstream.id));
  const remove = (session, headers) => session(target, { method: 'DELETE', data: {}, headers });
  assert.equal((await remove(client(), scope(tenantA))).status, 401);
  assert.equal((await remove(admin)).status, 422);
  assert.equal((await remove(admin, { ...scope(tenantA), 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await remove(operator, scope(tenantA))).status, 403);
  assert.equal((await remove(viewer, scope(tenantA))).status, 403);
  assert.equal((await remove(other, scope(tenantB))).status, 404);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await remove(global, scope(tenantA))).status, 409);

  const results = await Promise.all([remove(admin, scope(tenantA)), remove(admin, scope(tenantA))]);
  assert.deepEqual(results.map(response => response.status).sort(), [204, 404]);
  assert.equal(await results.find(response => response.status === 204).text(), '');
  assert.deepEqual(await list(viewer, services), own.filter(row => row.id !== removed.id));
  assert.equal((await viewer(target + '/dependencies')).status, 404);
  assert.deepEqual(await list(viewer, consumerDependencies), before.filter(row => row.upstream_service_id !== removed.id));
  assert.ok((await list(viewer, '/inventory/assets')).some(row => row.id === assetId));
  assert.deepEqual(await list(other, services), foreign);
  for (const session of [admin, other, operator, viewer, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Exclusão de serviço, dependências nos dois sentidos, papéis e isolamento verificados por HTTPS.');
  process.exit(0);
}

if (process.argv.includes('--audit-read')) {
  const viewer = client();
  const other = client();
  const global = client();
  const path = '/inventory/audit';
  const scope = tenant => ({ 'X-AIOps-Expected-Tenant': tenant });
  const login = (session, name, password = name) => session('/login', {
    data: { email: name + '-auth@example.invalid', password: password + '-ci-fixture-only' },
  });
  const page = async (session, tenant, after, limit = 1) => {
    const query = new URLSearchParams({ limit: String(limit), ...(after ? { after } : {}), tenant_id: tenantB });
    const response = await session(path + '?' + query, { headers: scope(tenant) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response.json();
  };
  assert.equal((await viewer(path, { headers: scope(tenantA) })).status, 401);
  assert.equal((await login(viewer, 'viewer')).status, 204);
  assert.equal((await login(other, 'admin-b', 'admin')).status, 204);
  assert.equal((await login(global, 'global')).status, 204);
  assert.equal((await viewer(path)).status, 422);
  assert.equal((await viewer(path, { headers: scope(tenantB) })).status, 409);
  assert.equal((await global(path, { headers: scope(tenantA) })).status, 409);
  assert.equal((await viewer(path + '?after=invalid', { headers: scope(tenantA) })).status, 422);
  assert.equal((await viewer(path + '?limit=101', { headers: scope(tenantA) })).status, 422);
  assert.equal((await viewer(path, { data: {}, headers: scope(tenantA) })).status, 404);

  const before = '2025-01-03T00:00:00+00:00~ffffffff-ffff-ffff-ffff-ffffffffffff';
  const first = await page(viewer, tenantA, before);
  assert.deepEqual(first.items.map(row => row.action), ['AUDIT_FEED_NEWER_ID']);
  assert.deepEqual(Object.keys(first.items[0]).sort(),
    ['action', 'actor_role', 'created_at_utc', 'id', 'resource_id', 'resource_type', 'tenant_id']);
  assert.equal(first.items[0].tenant_id, tenantA);
  assert.ok(first.next_after);
  const second = await page(viewer, tenantA, first.next_after);
  assert.deepEqual(second.items.map(row => row.action), ['AUDIT_FEED_OLDER_ID']);
  assert.ok(second.next_after);
  const last = await page(viewer, tenantA, second.next_after);
  assert.deepEqual(last.items.map(row => row.action), ['AUDIT_FEED_OLDER_TIME']);
  assert.equal(last.next_after, null);

  assert.deepEqual((await page(other, tenantB, before, 10)).items.map(row => row.action), ['AUDIT_FEED_FOREIGN']);
  assert.equal((await global('/switch-tenant', { data: { tenant_id: tenantB } })).status, 200);
  assert.equal((await global(path, { headers: scope(tenantA) })).status, 409);
  assert.deepEqual((await page(global, tenantB, before, 10)).items.map(row => row.action), ['AUDIT_FEED_FOREIGN']);
  for (const session of [viewer, other, global]) {
    assert.equal((await session('/logout', { data: {} })).status, 204);
  }
  console.log('Trilha de auditoria por HTTPS, paginação, escopo da sessão e campos permitidos verificados.');
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
for (const resource of ['asset-categories', 'concessions', 'locality-types']) {
  assert.equal((await operator('/inventory/' + resource, { data: {} })).status, 404);
}
assert.equal((await operator('/inventory/concessions/' + tenantA, {
  method: 'DELETE', data: {}, headers: { 'X-AIOps-Expected-Tenant': tenantA },
})).status, 404);
assert.equal((await operator('/tenants', { data: { name: 'Fixture' } })).status, 404);
assert.equal((await operator('/tenant-users', { headers: { 'X-AIOps-Expected-Tenant': tenantA } })).status, 404);
assert.equal((await operator('/inventory/topology/edges')).status, 200);
assert.equal((await operator('/inventory/topology/edges', { data: {} })).status, 404);
assert.equal((await operator('/inventory/sites', { data: { name: 'fixture', code: 'fixture' } })).status, 404);
assert.equal((await operator('/inventory/sites/' + tenantA, {
  method: 'DELETE', data: {}, headers: { 'X-AIOps-Expected-Tenant': tenantA },
})).status, 404);
assert.equal((await operator('/inventory/assets/' + tenantA, {
  method: 'DELETE', data: {}, headers: { 'X-AIOps-Expected-Tenant': tenantA },
})).status, 404);
assert.equal((await operator('/inventory/services/' + tenantA, {
  method: 'DELETE', data: {}, headers: { 'X-AIOps-Expected-Tenant': tenantA },
})).status, 404);
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
