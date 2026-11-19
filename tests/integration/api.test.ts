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
  const text = await resp.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: resp.status, body };
}

test('fluxo vertical completo: cadastro, topologia sem ciclo, ingestão idempotente, RCA e estados honestos ML', async () => {
  const { server, db, baseUrl } = await startTestServer();
  try {
    const boot = await apiJson(baseUrl, '/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        email: 'noc@test.local',
        full_name: 'NOC Lead',
        password: 'NocPassword123',
        initial_tenant_name: 'Operadora Fixture',
      }),
    });
    assert.equal(boot.status, 201);
    const token = boot.body.token as string;

    // Overview inicial deve reportar NOT_CONFIGURED e MODEL_NOT_VALIDATED sem dados inventados
    const overviewEmpty = await apiJson(baseUrl, '/api/noc/overview', { token });
    assert.equal(overviewEmpty.status, 200);
    assert.equal((overviewEmpty.body.honest_states as Record<string, string>).telemetry_status, 'NOT_CONFIGURED');
    assert.equal((overviewEmpty.body.honest_states as Record<string, string>).ml_status, 'MODEL_NOT_VALIDATED');

    // Concessão + Site com coordenadas verificadas
    const conc = await apiJson(baseUrl, '/api/concessions', {
      method: 'POST',
      token,
      body: JSON.stringify({ code: 'CONC-01', name: 'Regional Centro' }),
    });
    assert.equal(conc.status, 201);

    const site = await apiJson(baseUrl, '/api/sites', {
      method: 'POST',
      token,
      body: JSON.stringify({
        code: 'ETA-01',
        name: 'ETA Central Fixture',
        concession_id: (conc.body.concession as { id: string }).id,
        municipality: 'São Paulo',
        uf: 'SP',
        latitude: -23.5505,
        longitude: -46.6333,
        coord_precision: 'manual_verificada',
        coord_verified: true,
        criticality: 'critica',
      }),
    });
    assert.equal(site.status, 201);
    const siteId = (site.body.site as { id: string }).id;

    // Dois ativos + enlace topológico + bloqueio de ciclo
    const asset1 = await apiJson(baseUrl, '/api/assets', {
      method: 'POST',
      token,
      body: JSON.stringify({ site_id: siteId, name: 'UPS-ETA-01', criticality: 'critica' }),
    });
    const asset2 = await apiJson(baseUrl, '/api/assets', {
      method: 'POST',
      token,
      body: JSON.stringify({ site_id: siteId, name: 'RTR-ETA-01', criticality: 'alta' }),
    });
    const a1Id = (asset1.body.asset as { id: string }).id;
    const a2Id = (asset2.body.asset as { id: string }).id;

    const edgeOk = await apiJson(baseUrl, '/api/topology/edges', {
      method: 'POST',
      token,
      body: JSON.stringify({ source_asset_id: a1Id, target_asset_id: a2Id, link_type: 'power_feed' }),
    });
    assert.equal(edgeOk.status, 201);

    const edgeCycle = await apiJson(baseUrl, '/api/topology/edges', {
      method: 'POST',
      token,
      body: JSON.stringify({ source_asset_id: a2Id, target_asset_id: a1Id, link_type: 'power_feed' }),
    });
    assert.equal(edgeCycle.status, 400);

    // Criar conector webhook_csv e testar ingestão idempotente
    const conn = await apiJson(baseUrl, '/api/integrations/connectors', {
      method: 'POST',
      token,
      body: JSON.stringify({ connector_type: 'webhook_csv', name: 'Receptor Teste' }),
    });
    assert.equal(conn.status, 201);
    const connId = conn.body.id as string;

    const eventPayload = {
      events: [
        {
          idempotency_key: 'fixture-evt-001',
          site_id: siteId,
          asset_id: a1Id,
          event_time_utc: '2026-11-18T12:00:00Z',
          observed_at_utc: '2026-11-18T12:00:00Z',
          source: 'ups_field',
          event_type: 'power_outage',
          status: 'DOWN',
        },
      ],
    };

    const ingest1 = await apiJson(baseUrl, `/api/integrations/connectors/${connId}/ingest`, {
      method: 'POST',
      token,
      body: JSON.stringify(eventPayload),
    });
    assert.equal(ingest1.status, 201);
    assert.equal(ingest1.body.ingested, 1);
    assert.equal(ingest1.body.created_incidents, 1);

    // Reenvio com mesma idempotency_key deve deduplicar
    const ingest2 = await apiJson(baseUrl, `/api/integrations/connectors/${connId}/ingest`, {
      method: 'POST',
      token,
      body: JSON.stringify(eventPayload),
    });
    assert.equal(ingest2.status, 201);
    assert.equal(ingest2.body.ingested, 0);
    assert.equal(ingest2.body.deduplicated, 1);

    // Incidente criado com RCA elétrica e revisão humana
    const incList = await apiJson(baseUrl, '/api/incidents', { token });
    assert.equal(incList.status, 200);
    const incidents = incList.body.incidents as Array<{ id: string; rca_category: string }>;
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].rca_category, 'eletrica');

    const review = await apiJson(baseUrl, `/api/incidents/${incidents[0].id}/rca-review`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ rca_category: 'eletrica', status: 'RESOLVED', review_note: 'Confirmado disjuntor' }),
    });
    assert.equal(review.status, 200);

    // Exportação isolada por tenant
    const csvExport = await apiJson(baseUrl, '/api/reports/export?format=csv', { token });
    assert.equal(csvExport.status, 200);
    assert.ok(String(csvExport.body.raw).includes('ETA-01'));
  } finally {
    server.close();
    db.close();
  }
});
