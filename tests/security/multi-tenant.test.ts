import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createApp } from '../../src/server/app.ts';

async function startTestServer() {
  const { app, db } = createApp({ dbPath: ':memory:' });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { server, db, baseUrl };
}

async function apiJson(baseUrl: string, path: string, options: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const resp = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers as Record<string, string>) } });
  const body = await resp.json().catch(() => ({}));
  return { status: resp.status, body };
}

test('isolamento multi-tenant, RBAC estrito e auditoria de troca de tenant', async () => {
  const { server, db, baseUrl } = await startTestServer();
  try {
    // 1. Bootstrap super_admin + Tenant A (fixture exclusiva de teste)
    const boot = await apiJson(baseUrl, '/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        email: 'root@test.local',
        full_name: 'Root Test',
        password: 'RootPassword123',
        initial_tenant_name: 'Tenant Alpha',
      }),
    });
    assert.equal(boot.status, 201);
    const superToken = boot.body.token as string;
    const tenantAId = boot.body.user.active_tenant_id as string;

    // 2. Criar Tenant B como super_admin
    const tB = await apiJson(baseUrl, '/api/tenants', {
      method: 'POST',
      token: superToken,
      body: JSON.stringify({ name: 'Tenant Beta' }),
    });
    assert.equal(tB.status, 201);
    const tenantBId = tB.body.tenant.id as string;

    // 3. Criar site no Tenant A
    const siteA = await apiJson(baseUrl, '/api/sites', {
      method: 'POST',
      token: superToken,
      body: JSON.stringify({ code: 'SITE-A1', name: 'Site Alpha 1' }),
    });
    assert.equal(siteA.status, 201);

    // 4. Criar tenant_admin no Tenant A e tentar criar super_admin (deve falhar com 403)
    const adminA = await apiJson(baseUrl, '/api/users', {
      method: 'POST',
      token: superToken,
      body: JSON.stringify({
        email: 'admin.a@test.local',
        full_name: 'Admin Alpha',
        password: 'AdminPassword123',
        role: 'tenant_admin',
      }),
    });
    assert.equal(adminA.status, 201);

    const loginAdminA = await apiJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin.a@test.local', password: 'AdminPassword123' }),
    });
    assert.equal(loginAdminA.status, 200);
    const adminAToken = loginAdminA.body.token as string;

    const escalate = await apiJson(baseUrl, '/api/users', {
      method: 'POST',
      token: adminAToken,
      body: JSON.stringify({
        email: 'evil@test.local',
        full_name: 'Evil',
        password: 'EvilPassword123',
        role: 'super_admin',
      }),
    });
    assert.equal(escalate.status, 403);

    // 5. Trocar super_admin para Tenant B e criar tenant_viewer no Tenant B
    const sw = await apiJson(baseUrl, '/api/auth/switch-tenant', {
      method: 'POST',
      token: superToken,
      body: JSON.stringify({ tenant_id: tenantBId }),
    });
    assert.equal(sw.status, 200);
    assert.equal(sw.body.active_tenant_id, tenantBId);
    assert.equal(sw.body.user.active_tenant_id, tenantBId);

    const meAfterSwitch = await apiJson(baseUrl, '/api/auth/me', { token: superToken });
    assert.equal(meAfterSwitch.status, 200);
    assert.equal(meAfterSwitch.body.user.active_tenant_id, tenantBId);

    const viewerB = await apiJson(baseUrl, '/api/users', {
      method: 'POST',
      token: superToken,
      body: JSON.stringify({
        email: 'viewer.b@test.local',
        full_name: 'Viewer Beta',
        password: 'ViewerPassword123',
        role: 'tenant_viewer',
      }),
    });
    assert.equal(viewerB.status, 201);

    const loginViewerB = await apiJson(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'viewer.b@test.local', password: 'ViewerPassword123' }),
    });
    const viewerBToken = loginViewerB.body.token as string;

    // 6. Viewer B não vê sites do Tenant A, e tentativa de acesso cruzado via query/header retorna 403
    const ownSites = await apiJson(baseUrl, '/api/sites', { token: viewerBToken });
    assert.equal(ownSites.status, 200);
    assert.equal(ownSites.body.sites.length, 0);

    const crossReadQuery = await apiJson(baseUrl, `/api/sites?tenant_id=${tenantAId}`, { token: viewerBToken });
    assert.equal(crossReadQuery.status, 403);

    const crossReadHeader = await apiJson(baseUrl, '/api/sites', {
      token: viewerBToken,
      headers: { 'X-Tenant-Id': tenantAId },
    });
    assert.equal(crossReadHeader.status, 403);

    // 7. Viewer B não pode cadastrar site (RBAC)
    const viewerWrite = await apiJson(baseUrl, '/api/sites', {
      method: 'POST',
      token: viewerBToken,
      body: JSON.stringify({ code: 'SITE-B1', name: 'Site Beta' }),
    });
    assert.equal(viewerWrite.status, 403);

    // 8. Verifica trilha de auditoria para SUPER_ADMIN_TENANT_SWITCH e CROSS_TENANT_ACCESS_DENIED
    const auditRows = db.prepare('SELECT action FROM audit_logs').all() as Array<{ action: string }>;
    const actions = auditRows.map((r) => r.action);
    assert.ok(actions.includes('SUPER_ADMIN_TENANT_SWITCH'));
    assert.ok(actions.includes('CROSS_TENANT_ACCESS_DENIED'));
  } finally {
    server.close();
    db.close();
  }
});
