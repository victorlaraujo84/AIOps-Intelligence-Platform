import assert from 'node:assert/strict';

const base = process.env.AIOPS_POSTGRES_CONSOLE_TEST_ORIGIN ?? 'https://localhost';
const imported = process.argv.includes('--imported');
const readOnly = process.argv.includes('--read-only');
const credentials = imported
  ? { email: 'admin@example.invalid', password: 'admin-fixture-only' }
  : { email: 'release-admin@example.invalid', password: 'release-bootstrap-fixture-only' };
let cookie;
let tenant;

async function request(path, status, data, method = data === undefined ? 'GET' : 'POST') {
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (tenant) headers.set('X-AIOps-Expected-Tenant', tenant);
  if (data !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + path, {
    headers, method, body: data === undefined ? undefined : JSON.stringify(data),
  });
  assert.equal(response.status, status, path);
  if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie').split(';', 1)[0];
  return response.status === 204 ? undefined : response.json();
}

const root = '/api/postgres-console';
assert.equal((await fetch(base + '/', { redirect: 'manual' })).headers.get('Location'), '/postgres-inventory');
assert.equal((await request('/api/health', 200)).db, 'connected');
await request('/api/auth/status', 404);
await request(root + '/login', 204, credentials);
if (imported) {
  const { items } = await request(root + '/tenants', 200);
  tenant = items.find(row => row.slug === 'inventory-fixture')?.id;
  assert.ok(tenant);
  await request(root + '/switch-tenant', 200, { tenant_id: tenant });
  const audit = await request(root + '/inventory/audit', 200);
  assert.ok(audit.items.some(row => row.action === 'AUDIT_IMPORTED' && row.resource_id === 'legacy/site'));
  const sites = await request(root + '/inventory/sites', 200);
  assert.deepEqual(sites.items.map(site => site.code), ['site']);
  const connectors = await request(root + '/inventory/connectors', 200);
  assert.deepEqual(Object.keys(connectors.items[0]).sort(), ['connector_type', 'id', 'last_sync_at_utc', 'name', 'status', 'tenant_id']);
  const events = await request(root + '/inventory/feed/events', 200);
  assert.deepEqual(events.items.map(row => row.source), ['fixture']);
  const incidents = await request(root + '/inventory/feed/incidents', 200);
  assert.deepEqual(incidents.items.map(row => row.status), [readOnly ? 'RESOLVED' : 'OPEN']);
  const incidentId = incidents.items[0].id;
  const incidentPath = root + '/inventory/incidents/' + incidentId;
  const reviewPath = incidentPath + '/rca-review';
  const detail = await request(incidentPath, 200);
  assert.deepEqual(detail.events.map(event => event.id), events.items.map(event => event.id));
  assert.equal(detail.events[0].role_in_incident, 'symptom');
  assert.equal(detail.incident.rca_evidence[0].evidence, detail.incident.title);
  const metrics = await request(root + '/inventory/feed/metrics', 200);
  assert.deepEqual(metrics.items.map(row => row.value_num), [1]);
  if (readOnly) {
    const flags = await request(root + '/status', 200);
    assert.deepEqual([flags.site_writes, flags.asset_writes, flags.service_writes, flags.user_admin, flags.tenant_creation, flags.incident_writes],
      [false, false, false, false, false, false]);
    await request(root + '/inventory/sites', 404, { code: 'BLOCKED', name: 'Bloqueado' });
    await request(reviewPath, 404, { expected_review: detail.incident.human_reviewed_at_utc, status: 'OPEN' }, 'PATCH');
    assert.ok(detail.incident.resolved_at_utc);
  } else {
    const fixtureTenant = tenant;
    const initial = { expected_review: null, status: 'ACKNOWLEDGED' };
    const viewer = { email: 'release-viewer@example.invalid', password: 'viewer-fixture-only' };
    await request(root + '/tenant-users', 201, { ...viewer, full_name: 'Viewer fixture', role: 'tenant_viewer' });
    const other = await request(root + '/tenants', 201, { name: 'Release isolated' });
    await request(root + '/switch-tenant', 200, { tenant_id: other.id });
    await request(incidentPath, 409);
    await request(reviewPath, 409, initial, 'PATCH');
    tenant = other.id;
    await request(incidentPath, 404);
    await request(reviewPath, 404, initial, 'PATCH');
    await request(root + '/logout', 204, {});
    tenant = fixtureTenant;
    await request(root + '/login', 204, viewer);
    await request(incidentPath, 200);
    await request(reviewPath, 403, initial, 'PATCH');
    await request(root + '/logout', 204, {});
    await request(root + '/login', 204, credentials);
    await request(root + '/switch-tenant', 200, { tenant_id: tenant });
    const operator = { email: 'release-operator@example.invalid', password: 'operator-fixture-only' };
    await request(root + '/tenant-users', 201, { ...operator, full_name: 'Operator fixture', role: 'tenant_operator' });
    await request(root + '/logout', 204, {});
    await request(root + '/login', 204, operator);
    await request(reviewPath, 422, { ...initial, status: 'UNKNOWN' }, 'PATCH');
    await request(reviewPath, 422, { expected_review: null }, 'PATCH');
    const reviewed = await request(reviewPath, 200, { ...initial, rca_category: 'ti_aplicacao', review_note: 'Nota fixture' }, 'PATCH');
    assert.equal(reviewed.status, 'ACKNOWLEDGED');
    await request(reviewPath, 409, initial, 'PATCH');
    await request(reviewPath, 200, { expected_review: reviewed.human_reviewed_at_utc, status: 'RESOLVED' }, 'PATCH');
    const { incident: resolved } = await request(incidentPath, 200);
    assert.ok(resolved.resolved_at_utc);
    assert.equal(resolved.rca_category, 'ti_aplicacao');
    assert.equal(resolved.rca_evidence[1].note, 'Nota fixture');
    assert.equal(resolved.rca_evidence.length, 2);
    const updatedAudit = await request(root + '/inventory/audit', 200);
    assert.equal(updatedAudit.items.filter(row => row.action === 'INCIDENT_RCA_REVIEWED'
      && row.resource_id === incidentId && row.actor_role === 'tenant_operator').length, 2);
  }

} else if (process.argv.includes('--verify-restart')) {
  const { items } = await request(root + '/tenants', 200);
  assert.deepEqual(items.map(row => row.slug), ['release-ci']);
  tenant = items[0].id;
  await request(root + '/switch-tenant', 200, { tenant_id: tenant });
  const sites = await request(root + '/inventory/sites', 200);
  assert.ok(sites.items.some(site => site.code === 'RELEASE-SITE'));
} else {
  assert.equal((await request(root + '/tenants', 200)).items.length, 0);
  const created = await request(root + '/tenants', 201, { name: 'Release CI' });
  tenant = created.id;
  assert.equal((await request(root + '/me', 200)).active_tenant_id, tenant);
  const site = await request(root + '/inventory/sites', 201, { code: 'RELEASE-SITE', name: 'Site CI' });
  assert.equal(site.tenant_id, tenant);
  const asset = await request(root + '/inventory/assets', 201, {
    name: 'Ativo CI', site_id: site.id, ip_address: '2001:db8::1', vendor: 'Fabricante CI', redundancy_group: 'A',
  });
  assert.equal(asset.ip_address, '2001:db8::1');
  assert.equal(asset.vendor, 'Fabricante CI');
  assert.equal(asset.redundancy_group, 'A');
  await request(root + '/inventory/assets', 422, { name: 'IP inválido', ip_address: 'invalido' });
  await request(root + '/geo/cep/invalid', 422);
  await request(root + '/geo/geocode', 422, { municipality: 'Test', uf: 'XXX' });
  const audit = await request(root + '/inventory/audit', 200);
  assert.ok(audit.items.some(row => row.action === 'SITE_CREATED' && row.resource_id === site.id));
}
await request(root + '/logout', 204, {});
console.log('Console PostgreSQL unificado validado por HTTPS.');
