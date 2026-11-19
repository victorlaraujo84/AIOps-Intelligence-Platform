import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/server/db.ts';
import { createApp } from '../../src/server/app.ts';

async function startServer() {
  const { app, db } = createApp({ dbPath: ':memory:' });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  return { server, db, baseUrl: `http://127.0.0.1:${addr.port}` };
}

async function req(baseUrl: string, path: string, options: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const resp = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = (await resp.json()) as Record<string, unknown>;
  return { status: resp.status, body };
}

test('evolução híbrida: migração v1->v2 preserva dados, ativos sem site, serviços, CSV checkpoint, OTLP e filtro por domínio', async () => {
  // 1. Simula banco SQLite legado v1 com CHECK rígido e ativo vinculado a site
  const legacyDb = new Database(':memory:');
  legacyDb.exec(`
    CREATE TABLE tenants (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, document TEXT, status TEXT NOT NULL DEFAULT 'active', created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, tenant_id TEXT, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, role TEXT NOT NULL, password_hash TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, created_at_utc TEXT NOT NULL, last_login_utc TEXT);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, active_tenant_id TEXT, token_hash TEXT NOT NULL UNIQUE, expires_at_utc TEXT NOT NULL, created_at_utc TEXT NOT NULL);
    CREATE TABLE concessions (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, code TEXT NOT NULL, region TEXT, description TEXT, created_at_utc TEXT NOT NULL);
    CREATE TABLE locality_types (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL, description TEXT, created_at_utc TEXT NOT NULL);
    CREATE TABLE sites (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, concession_id TEXT, locality_type_id TEXT, code TEXT NOT NULL, name TEXT NOT NULL, address TEXT, cep TEXT, municipality TEXT, uf TEXT, latitude REAL, longitude REAL, coord_precision TEXT NOT NULL DEFAULT 'pendente', coord_verified INTEGER NOT NULL DEFAULT 0, criticality TEXT NOT NULL DEFAULT 'media', created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
    CREATE TABLE asset_categories (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL, domain TEXT NOT NULL CHECK (domain IN ('rede', 'energia', 'infra', 'sensor')), created_at_utc TEXT NOT NULL);
    CREATE TABLE assets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT NOT NULL, category_id TEXT, name TEXT NOT NULL, hostname TEXT, ip_address TEXT, vendor TEXT, model TEXT, provider_name TEXT, redundancy_group TEXT, topology_parent_id TEXT, criticality TEXT NOT NULL DEFAULT 'media', operational_state TEXT NOT NULL DEFAULT 'NO_DATA', created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
    CREATE TABLE topology_edges (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source_asset_id TEXT NOT NULL, target_asset_id TEXT NOT NULL, link_type TEXT NOT NULL, provider_name TEXT, capacity_mbps REAL, is_redundant INTEGER NOT NULL DEFAULT 0, created_at_utc TEXT NOT NULL);
    CREATE TABLE connectors (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connector_type TEXT NOT NULL CHECK (connector_type IN ('open_meteo', 'inmet', 'cemaden', 'zabbix', 'prtg', 'snmp_trap', 'energy_ups', 'webhook_csv')), name TEXT NOT NULL, endpoint_url TEXT, auth_mode TEXT NOT NULL DEFAULT 'none', encrypted_credentials TEXT, config_json TEXT NOT NULL DEFAULT '{}', poll_interval_sec INTEGER NOT NULL DEFAULT 300, status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED', last_sync_at_utc TEXT, last_error TEXT, created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL);
    CREATE TABLE connector_sync_runs (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, connector_id TEXT NOT NULL, started_at_utc TEXT NOT NULL, finished_at_utc TEXT, status TEXT NOT NULL, records_ingested INTEGER NOT NULL DEFAULT 0, records_deduplicated INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER, error_message TEXT, raw_metadata_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE canonical_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, site_id TEXT, asset_id TEXT, connector_id TEXT, idempotency_key TEXT NOT NULL, event_time_utc TEXT NOT NULL, observed_at_utc TEXT NOT NULL, ingested_at_utc TEXT NOT NULL, forecast_issued_at_utc TEXT, source TEXT NOT NULL, event_type TEXT NOT NULL, status TEXT NOT NULL, lat REAL, lon REAL, quality_flag TEXT NOT NULL DEFAULT 'VALID', payload_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE incidents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, root_site_id TEXT, root_asset_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'OPEN', severity TEXT NOT NULL DEFAULT 'MEDIA', rca_category TEXT NOT NULL DEFAULT 'desconhecida', rca_confidence REAL, rca_evidence_json TEXT NOT NULL DEFAULT '[]', rule_version TEXT NOT NULL DEFAULT 'rca-rules-v1.0', human_reviewed_by TEXT, human_reviewed_at_utc TEXT, opened_at_utc TEXT NOT NULL, resolved_at_utc TEXT);
    CREATE TABLE incident_events (incident_id TEXT NOT NULL, event_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role_in_incident TEXT NOT NULL DEFAULT 'symptom', PRIMARY KEY (incident_id, event_id));
    CREATE TABLE ai_agent_configs (tenant_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'offline', endpoint_url TEXT, encrypted_api_key TEXT, model_name TEXT, data_sharing_authorized INTEGER NOT NULL DEFAULT 0, timeout_ms INTEGER NOT NULL DEFAULT 15000, updated_by TEXT, updated_at_utc TEXT NOT NULL);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, tenant_id TEXT, actor_user_id TEXT, actor_email TEXT, actor_role TEXT, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, details_json TEXT NOT NULL DEFAULT '{}', ip_address TEXT, created_at_utc TEXT NOT NULL);
    INSERT INTO tenants VALUES ('t-legado', 'Legado', 'legado', NULL, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO sites (id, tenant_id, code, name, created_at_utc, updated_at_utc) VALUES ('s-legado', 't-legado', 'LEG-01', 'Site Legado', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    INSERT INTO assets (id, tenant_id, site_id, name, created_at_utc, updated_at_utc) VALUES ('a-legado', 't-legado', 's-legado', 'RTR-LEGADO', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `);
  const { runSqliteMigrations } = await import('../../src/server/migrations.ts');
  runSqliteMigrations(legacyDb, ':memory:');
  const preserved = legacyDb.prepare('SELECT id, georeference_mode FROM assets WHERE id = ?').get('a-legado') as {
    id: string;
    georeference_mode: string;
  };
  assert.equal(preserved.id, 'a-legado');
  assert.equal(preserved.georeference_mode, 'required');
  legacyDb.close();

  // 2. Fluxo HTTP híbrido completo
  const { server, db, baseUrl } = await startServer();
  try {
    const boot = await req(baseUrl, '/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        email: 'arch@test.local',
        full_name: 'Arquiteto AIOps',
        password: 'StrongPassword123',
        initial_tenant_name: 'Grupo Híbrido',
      }),
    });
    const token = boot.body.token as string;

    // Categoria extensível sem enum rígido
    const catRes = await req(baseUrl, '/api/asset-categories', {
      method: 'POST',
      token,
      body: JSON.stringify({ code: 'kube_cluster', label: 'Cluster Kubernetes', domain: 'ti' }),
    });
    assert.equal(catRes.status, 201);

    // Ativo lógico de TI SEM site_id (georreferenciamento opcional / none)
    const itAsset = await req(baseUrl, '/api/assets', {
      method: 'POST',
      token,
      body: JSON.stringify({
        name: 'K8S-PROD-01',
        domain: 'ti',
        georeference_mode: 'none',
        category_id: (catRes.body.asset_category as { id: string }).id,
      }),
    });
    assert.equal(itAsset.status, 201);
    const assetId = (itAsset.body.asset as { id: string; site_id: string | null }).id;
    assert.equal((itAsset.body.asset as { site_id: string | null }).site_id, null);

    // Serviço + Dependência + Rejeição de Ciclo
    const svc1 = await req(baseUrl, '/api/services', {
      method: 'POST',
      token,
      body: JSON.stringify({ code: 'SVC-ERP', name: 'ERP Corporativo', domain: 'ti', sla_target_pct: 99.95 }),
    });
    assert.equal(svc1.status, 201);
    const svc1Id = (svc1.body.service as { id: string }).id;

    const depAsset = await req(baseUrl, `/api/services/${svc1Id}/dependencies`, {
      method: 'POST',
      token,
      body: JSON.stringify({ asset_id: assetId, dependency_role: 'primary' }),
    });
    assert.equal(depAsset.status, 201);

    const selfCycle = await req(baseUrl, `/api/services/${svc1Id}/dependencies`, {
      method: 'POST',
      token,
      body: JSON.stringify({ upstream_service_id: svc1Id }),
    });
    assert.equal(selfCycle.status, 400);

    // Catálogo de conectores: SLAview deve estar explicitamente marcado como PENDING_EXTERNAL_SPEC / NOT_CONFIGURED
    const catalog = await req(baseUrl, '/api/integrations/catalog', { token });
    assert.equal(catalog.status, 200);
    const slaview = (catalog.body.catalog as Array<{ connector_type: string; availability: string }>).find(
      (c) => c.connector_type === 'slaview',
    );
    assert.equal(slaview?.availability, 'PENDING_EXTERNAL_SPEC');

    const slaviewConn = await req(baseUrl, '/api/integrations/connectors', {
      method: 'POST',
      token,
      body: JSON.stringify({ connector_type: 'slaview', name: 'SLAview Pendente' }),
    });
    assert.equal(slaviewConn.status, 201);
    assert.equal(slaviewConn.body.status, 'NOT_CONFIGURED');

    // Conector CSV Incremental com retomada por checkpoint
    const csvConn = await req(baseUrl, '/api/integrations/connectors', {
      method: 'POST',
      token,
      body: JSON.stringify({ connector_type: 'webhook_csv', name: 'Historico CSV' }),
    });
    const csvConnId = csvConn.body.id as string;
    const csvData = [
      'asset_id,metric_name,value_num,unit,observed_at_utc,source',
      `${assetId},cpu_pct,22.0,%,2026-11-19T08:00:00Z,csv`,
      `${assetId},cpu_pct,23.5,%,2026-11-19T08:05:00Z,csv`,
      `${assetId},cpu_pct,21.0,%,2026-11-19T08:10:00Z,csv`,
    ].join('\n');

    const batch1 = await req(baseUrl, `/api/integrations/connectors/${csvConnId}/ingest-csv`, {
      method: 'POST',
      token,
      body: JSON.stringify({ csv_text: csvData, kind: 'metrics', cursor_key: 'lote-1', batch_limit: 2 }),
    });
    assert.equal(batch1.status, 201);
    assert.equal(batch1.body.rows_processed_now, 2);
    assert.equal(batch1.body.status, 'IN_PROGRESS');

    const batch2 = await req(baseUrl, `/api/integrations/connectors/${csvConnId}/ingest-csv`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        csv_text: csvData,
        kind: 'metrics',
        cursor_key: 'lote-1',
        resume_from_checkpoint: true,
        batch_limit: 2,
      }),
    });
    assert.equal(batch2.status, 201);
    assert.equal(batch2.body.resumed_from_row, 2);
    assert.equal(batch2.body.rows_processed_now, 1);
    assert.equal(batch2.body.status, 'COMPLETED');

    // OTLP autorizado -> métricas e logs separados
    await req(baseUrl, '/api/collection/scopes', {
      method: 'POST',
      token,
      body: JSON.stringify({ protocol: 'otlp', target_cidr_or_host: 'k8s-prod-01.internal' }),
    });

    const otlpLog = await req(baseUrl, '/api/collection/otlp/v1/logs', {
      method: 'POST',
      token,
      body: JSON.stringify({
        source_target: 'k8s-prod-01.internal',
        logs: [
          {
            idempotency_key: 'otlp-log-1',
            asset_id: assetId,
            service_id: svc1Id,
            severity: 'WARN',
            message: 'Latência acima de 350ms no endpoint /checkout',
            observed_at_utc: '2026-11-19T09:00:00Z',
            source: 'otlp',
          },
        ],
      }),
    });
    assert.equal(otlpLog.status, 201);
    assert.equal(otlpLog.body.ingested, 1);

    // Health check endpoint
    const healthRes = await req(baseUrl, '/api/health');
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.body.db, 'connected');

    // Overview por domínio TI (sem incidentes ainda -> 24 baldes com zeros reais)
    const ovTi = await req(baseUrl, '/api/noc/overview?domain=ti', { token });
    assert.equal(ovTi.status, 200);
    const metricsObj = ovTi.body.metrics as Record<string, number>;
    assert.equal(metricsObj.assets_total, 1);
    assert.equal(metricsObj.assets_ungeoreferenced, 1);
    assert.equal(metricsObj.services_total, 1);
    const emptyTrend = ovTi.body.incidents_trend_24h as Array<{ opened: number; resolved: number }>;
    assert.equal(emptyTrend.length, 24);
    assert.equal(
      emptyTrend.reduce((acc, p) => acc + p.opened + p.resolved, 0),
      0,
    );

    // Registra 2 incidentes reais nas últimas 24h e resolve 1 via API para validar a série temporal
    const nowIso = new Date().toISOString();
    const tenantId = (ovTi.body.tenant as { id: string }).id;
    db.prepare(
      `INSERT INTO incidents (id, tenant_id, root_asset_id, title, status, severity, rca_category, opened_at_utc)
       VALUES (?, ?, ?, ?, 'OPEN', 'ALTA', 'ti_aplicacao', ?), (?, ?, ?, ?, 'OPEN', 'MEDIA', 'telecom_outros', ?)`,
    ).run('inc-trend-1', tenantId, assetId, 'Latência checkout', nowIso, 'inc-trend-2', tenantId, assetId, 'Perda pacote', nowIso);

    const resolveRes = await req(baseUrl, '/api/incidents/inc-trend-1/rca-review', {
      method: 'PATCH',
      token,
      body: JSON.stringify({ status: 'RESOLVED', review_note: 'Mitigado pelo NOC' }),
    });
    assert.equal(resolveRes.status, 200);

    const ovWithIncidents = await req(baseUrl, '/api/noc/overview', { token });
    assert.equal(ovWithIncidents.status, 200);
    const populatedTrend = ovWithIncidents.body.incidents_trend_24h as Array<{ opened: number; resolved: number }>;
    assert.equal(populatedTrend.length, 24);
    assert.equal(
      populatedTrend.reduce((acc, p) => acc + p.opened, 0),
      2,
    );
    assert.equal(
      populatedTrend.reduce((acc, p) => acc + p.resolved, 0),
      1,
    );
  } finally {
    server.close();
    db.close();
    // Garante que openDatabase também funciona normalmente
    const mem = openDatabase(':memory:');
    mem.close();
  }
});
