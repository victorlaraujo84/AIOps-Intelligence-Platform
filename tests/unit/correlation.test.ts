import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { openDatabase } from '../../src/server/db.ts';
import { detectMetricAnomaly, inferEventRcaCategory } from '../../src/server/correlation.ts';
import { ingestCanonicalEvents, ingestMetricSamples } from '../../src/server/integrations.ts';

test('detector de anomalias Z-Score exige >= 5 amostras prévias e identifica desvio real', () => {
  const db = openDatabase(':memory:');
  try {
    const tenantId = crypto.randomUUID();
    const assetId = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at_utc, updated_at_utc) VALUES (?, 'T1', 't1', 'active', ?, ?)`).run(
      tenantId,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO assets (id, tenant_id, site_id, domain, georeference_mode, name, created_at_utc, updated_at_utc)
       VALUES (?, ?, NULL, 'ti', 'none', 'API-NODE-01', ?, ?)`,
    ).run(assetId, tenantId, now, now);

    // 4 amostras iniciais: insuficiente para Z-score
    for (let i = 1; i <= 4; i++) {
      const r = ingestMetricSamples(db, tenantId, null, [
        {
          idempotency_key: `k-${i}`,
          asset_id: assetId,
          metric_name: 'cpu_pct',
          value_num: 20 + i,
          unit: '%',
          observed_at_utc: `2026-11-19T10:0${i}:00Z`,
          source: 'otlp',
        },
      ]);
      assert.equal(r.anomalies_detected, 0);
    }

    const checkFew = detectMetricAnomaly(db, tenantId, {
      asset_id: assetId,
      service_id: null,
      metric_name: 'cpu_pct',
      value_num: 99,
      observed_at_utc: '2026-11-19T10:05:00Z',
    });
    assert.equal(checkFew.detected, false);
    assert.ok(checkFew.reason?.includes('INSUFFICIENT_DATA'));

    // Completa baseline (>= 5 amostras) e injeta pico real
    for (let i = 5; i <= 7; i++) {
      ingestMetricSamples(db, tenantId, null, [
        {
          idempotency_key: `k-${i}`,
          asset_id: assetId,
          metric_name: 'cpu_pct',
          value_num: 21 + (i % 2),
          unit: '%',
          observed_at_utc: `2026-11-19T10:0${i}:00Z`,
          source: 'otlp',
        },
      ]);
    }

    const spikeRes = ingestMetricSamples(db, tenantId, null, [
      {
        idempotency_key: 'k-spike',
        asset_id: assetId,
        metric_name: 'cpu_pct',
        value_num: 98.5,
        unit: '%',
        observed_at_utc: '2026-11-19T10:15:00Z',
        source: 'otlp',
      },
    ]);
    assert.equal(spikeRes.anomalies_detected, 1);
  } finally {
    db.close();
  }
});

test('correlação multidomínio classifica RCA e conta serviços impactados via topologia', () => {
  const db = openDatabase(':memory:');
  try {
    const tenantId = crypto.randomUUID();
    const dbAssetId = crypto.randomUUID();
    const appAssetId = crypto.randomUUID();
    const svcId1 = crypto.randomUUID();
    const svcId2 = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at_utc, updated_at_utc) VALUES (?, 'T2', 't2', 'active', ?, ?)`).run(
      tenantId,
      now,
      now,
    );
    db.prepare(
      `INSERT INTO assets (id, tenant_id, site_id, domain, georeference_mode, name, created_at_utc, updated_at_utc)
       VALUES (?, ?, NULL, 'ti', 'none', 'PG-CORE-01', ?, ?)`,
    ).run(dbAssetId, tenantId, now, now);
    db.prepare(
      `INSERT INTO assets (id, tenant_id, site_id, domain, georeference_mode, name, created_at_utc, updated_at_utc)
       VALUES (?, ?, NULL, 'ti', 'none', 'API-CHECKOUT', ?, ?)`,
    ).run(appAssetId, tenantId, now, now);
    db.prepare(
      `INSERT INTO topology_edges (id, tenant_id, source_asset_id, target_asset_id, link_type, is_redundant, created_at_utc)
       VALUES (?, ?, ?, ?, 'db_dependency', 0, ?)`,
    ).run(crypto.randomUUID(), tenantId, dbAssetId, appAssetId, now);

    db.prepare(
      `INSERT INTO services (id, tenant_id, code, name, domain, criticality, operational_state, created_at_utc, updated_at_utc)
       VALUES (?, ?, 'SVC-CHECKOUT', 'Checkout Web', 'ti', 'critica', 'NO_DATA', ?, ?)`,
    ).run(svcId1, tenantId, now, now);
    db.prepare(
      `INSERT INTO services (id, tenant_id, code, name, domain, criticality, operational_state, created_at_utc, updated_at_utc)
       VALUES (?, ?, 'SVC-PORTAL', 'Portal Cliente', 'ti', 'alta', 'NO_DATA', ?, ?)`,
    ).run(svcId2, tenantId, now, now);

    db.prepare(
      `INSERT INTO service_dependencies (id, tenant_id, service_id, asset_id, dependency_role, weight, created_at_utc)
       VALUES (?, ?, ?, ?, 'primary', 1.0, ?)`,
    ).run(crypto.randomUUID(), tenantId, svcId1, appAssetId, now);
    db.prepare(
      `INSERT INTO service_dependencies (id, tenant_id, service_id, upstream_service_id, dependency_role, weight, created_at_utc)
       VALUES (?, ?, ?, ?, 'primary', 1.0, ?)`,
    ).run(crypto.randomUUID(), tenantId, svcId2, svcId1, now);

    assert.equal(inferEventRcaCategory('db_connection_pool_exhausted', 'otlp', 'ti'), 'ti_aplicacao');
    assert.equal(inferEventRcaCategory('mqtt_sensor_offline', 'mqtt', 'iot'), 'iot_sensor');

    const res = ingestCanonicalEvents(db, tenantId, null, [
      {
        idempotency_key: 'db-down-1',
        asset_id: dbAssetId,
        event_time_utc: '2026-11-19T12:00:00Z',
        observed_at_utc: '2026-11-19T12:00:00Z',
        source: 'otlp',
        event_type: 'db_down',
        status: 'DOWN',
      },
    ]);
    assert.equal(res.created_incidents, 1);

    const inc = db
      .prepare('SELECT rca_category, impacted_services_count, severity FROM incidents WHERE tenant_id = ?')
      .get(tenantId) as { rca_category: string; impacted_services_count: number; severity: string };
    assert.equal(inc.rca_category, 'ti_aplicacao');
    assert.equal(inc.impacted_services_count, 2);
    assert.equal(inc.severity, 'CRITICA');
  } finally {
    db.close();
  }
});
