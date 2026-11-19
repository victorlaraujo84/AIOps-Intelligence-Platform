import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import type { RcaCategory } from '../shared/types.ts';
import { collectConnectedAssets, type EdgePair, type ServiceDepPair } from './topology.ts';

export interface AnomalyCheckInput {
  asset_id: string | null;
  service_id: string | null;
  metric_name: string;
  value_num: number;
  observed_at_utc: string;
}

/**
 * Avalia anomalia estatística simples (Z-Score) para uma métrica numérica.
 * Regra anti-alucinação: exige pelo menos 5 amostras históricas válidas anteriores do mesmo escopo.
 */
export function detectMetricAnomaly(
  db: Database.Database,
  tenantId: string,
  sample: AnomalyCheckInput,
): { detected: boolean; z_score: number | null; anomaly_id?: string; reason?: string } {
  if (!Number.isFinite(sample.value_num)) {
    return { detected: false, z_score: null, reason: 'Valor não numérico.' };
  }

  let historyRows: Array<{ value_num: number }>;
  if (sample.asset_id) {
    historyRows = db
      .prepare(
        `SELECT value_num FROM metric_samples
         WHERE tenant_id = ? AND asset_id = ? AND metric_name = ? AND quality_flag = 'VALID'
           AND observed_at_utc < ?
         ORDER BY observed_at_utc DESC
         LIMIT 60`,
      )
      .all(tenantId, sample.asset_id, sample.metric_name, sample.observed_at_utc) as Array<{ value_num: number }>;
  } else if (sample.service_id) {
    historyRows = db
      .prepare(
        `SELECT value_num FROM metric_samples
         WHERE tenant_id = ? AND service_id = ? AND metric_name = ? AND quality_flag = 'VALID'
           AND observed_at_utc < ?
         ORDER BY observed_at_utc DESC
         LIMIT 60`,
      )
      .all(tenantId, sample.service_id, sample.metric_name, sample.observed_at_utc) as Array<{ value_num: number }>;
  } else {
    return { detected: false, z_score: null, reason: 'Amostra sem asset_id ou service_id para baseline.' };
  }

  if (historyRows.length < 5) {
    return {
      detected: false,
      z_score: null,
      reason: `INSUFFICIENT_DATA (${historyRows.length}/5 amostras prévias).`,
    };
  }

  const values = historyRows.map((r) => r.value_num);
  const mean = values.reduce((acc, v) => acc + v, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);

  if (stddev < 1e-6) {
    // Baseline constante: só sinaliza se houver desvio relativo expressivo (> 25% ou > 1.0 unidade)
    const diff = Math.abs(sample.value_num - mean);
    if (diff < Math.max(1.0, Math.abs(mean) * 0.25)) {
      return { detected: false, z_score: 0 };
    }
    const pseudoZ = sample.value_num >= mean ? 4.0 : -4.0;
    const anomalyId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO anomaly_detections (
        id, tenant_id, asset_id, service_id, metric_name, observed_value,
        baseline_mean, baseline_stddev, z_score, severity, detected_at_utc, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'MEDIA', ?, 'OPEN')`,
    ).run(
      anomalyId,
      tenantId,
      sample.asset_id,
      sample.service_id,
      sample.metric_name,
      sample.value_num,
      mean,
      0,
      pseudoZ,
      sample.observed_at_utc,
    );
    return { detected: true, z_score: pseudoZ, anomaly_id: anomalyId };
  }

  const z = (sample.value_num - mean) / stddev;
  if (Math.abs(z) < 3.0) {
    return { detected: false, z_score: Number(z.toFixed(3)) };
  }

  const severity = Math.abs(z) >= 4.5 ? 'ALTA' : 'MEDIA';
  const anomalyId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO anomaly_detections (
      id, tenant_id, asset_id, service_id, metric_name, observed_value,
      baseline_mean, baseline_stddev, z_score, severity, detected_at_utc, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`,
  ).run(
    anomalyId,
    tenantId,
    sample.asset_id,
    sample.service_id,
    sample.metric_name,
    sample.value_num,
    Number(mean.toFixed(4)),
    Number(stddev.toFixed(4)),
    Number(z.toFixed(3)),
    severity,
    sample.observed_at_utc,
  );

  return { detected: true, z_score: Number(z.toFixed(3)), anomaly_id: anomalyId };
}

export function inferEventRcaCategory(eventType: string, source: string, domain?: string | null): RcaCategory {
  const et = eventType.toLowerCase();
  const src = source.toLowerCase();
  const dom = (domain ?? '').toLowerCase();

  if (et.includes('power') || et.includes('ups') || et.includes('generator') || dom === 'energia') {
    return 'eletrica';
  }
  if (et.includes('weather') || et.includes('rain') || et.includes('wind') || dom === 'ambiente') {
    return 'climatica_direta';
  }
  if (
    et.includes('app') ||
    et.includes('http') ||
    et.includes('db') ||
    et.includes('otlp') ||
    et.includes('cpu') ||
    et.includes('memory') ||
    dom === 'ti'
  ) {
    return 'ti_aplicacao';
  }
  if (et.includes('mqtt') || et.includes('sensor') || et.includes('telemetry_iot') || dom === 'iot') {
    return 'iot_sensor';
  }
  if (
    et.includes('network') ||
    et.includes('link') ||
    et.includes('icmp') ||
    et.includes('snmp') ||
    src.includes('zabbix') ||
    src.includes('prtg') ||
    dom === 'rede'
  ) {
    return 'telecom_outros';
  }
  return 'desconhecida';
}

export function countImpactedServices(
  db: Database.Database,
  tenantId: string,
  assetIds: string[],
): { count: number; serviceNames: string[] } {
  if (assetIds.length === 0) return { count: 0, serviceNames: [] };

  const allDeps = db
    .prepare('SELECT service_id, asset_id, upstream_service_id FROM service_dependencies WHERE tenant_id = ?')
    .all(tenantId) as Array<{ service_id: string; asset_id: string | null; upstream_service_id: string | null }>;

  const assetSet = new Set(assetIds);
  const impactedServiceIds = new Set<string>();

  for (const dep of allDeps) {
    if (dep.asset_id && assetSet.has(dep.asset_id)) {
      impactedServiceIds.add(dep.service_id);
    }
  }

  // Propaga impacto para serviços que dependem dos serviços afetados
  const serviceDeps: ServiceDepPair[] = allDeps
    .filter((d) => d.upstream_service_id)
    .map((d) => ({ service_id: d.service_id, upstream_service_id: d.upstream_service_id }));

  let changed = true;
  while (changed) {
    changed = false;
    for (const sd of serviceDeps) {
      if (sd.upstream_service_id && impactedServiceIds.has(sd.upstream_service_id) && !impactedServiceIds.has(sd.service_id)) {
        impactedServiceIds.add(sd.service_id);
        changed = true;
      }
    }
  }

  if (impactedServiceIds.size === 0) return { count: 0, serviceNames: [] };

  const placeholders = [...impactedServiceIds].map(() => '?').join(',');
  const names = (
    db.prepare(`SELECT name FROM services WHERE tenant_id = ? AND id IN (${placeholders})`).all(tenantId, ...impactedServiceIds) as Array<{
      name: string;
    }>
  ).map((r) => r.name);

  return { count: impactedServiceIds.size, serviceNames: names };
}

/**
 * Correlaciona um evento crítico/falha com incidentes abertos no mesmo site,
 * ativo ou grafo de dependências (topologia + serviços), sem afirmar causalidade absoluta.
 */
export function correlateFailureEvent(
  db: Database.Database,
  tenantId: string,
  params: {
    eventId: string;
    siteId: string | null;
    assetId: string | null;
    assetDomain?: string | null;
    source: string;
    eventType: string;
    status: string;
    observedAtUtc: string;
    eventTimeUtc: string;
  },
): { createdIncident: boolean; incidentId: string } {
  const inferredCategory = inferEventRcaCategory(params.eventType, params.source, params.assetDomain);
  const edges = db
    .prepare('SELECT source_asset_id, target_asset_id FROM topology_edges WHERE tenant_id = ?')
    .all(tenantId) as EdgePair[];

  const relatedAssetIds = new Set<string>();
  let upstreamIds: string[] = [];
  let downstreamIds: string[] = [];

  if (params.assetId) {
    relatedAssetIds.add(params.assetId);
    const connected = collectConnectedAssets(edges, params.assetId);
    upstreamIds = connected.upstream;
    downstreamIds = connected.downstream;
    for (const u of upstreamIds) relatedAssetIds.add(u);
    for (const d of downstreamIds) relatedAssetIds.add(d);
  }

  const impacted = countImpactedServices(db, tenantId, [...relatedAssetIds]);

  // Busca incidente aberto no mesmo site OU em ativo upstream/downstream conectado
  let existingIncident:
    | { id: string; rca_category: RcaCategory; rca_evidence_json: string; severity: string; impacted_services_count: number }
    | undefined;

  if (relatedAssetIds.size > 0) {
    const placeholders = [...relatedAssetIds].map(() => '?').join(',');
    existingIncident = db
      .prepare(
        `SELECT id, rca_category, rca_evidence_json, severity, impacted_services_count
         FROM incidents
         WHERE tenant_id = ? AND status != 'RESOLVED' AND root_asset_id IN (${placeholders})
         ORDER BY opened_at_utc DESC LIMIT 1`,
      )
      .get(tenantId, ...relatedAssetIds) as typeof existingIncident;
  }

  if (!existingIncident && params.siteId) {
    existingIncident = db
      .prepare(
        `SELECT id, rca_category, rca_evidence_json, severity, impacted_services_count
         FROM incidents
         WHERE tenant_id = ? AND root_site_id = ? AND status != 'RESOLVED'
         ORDER BY opened_at_utc DESC LIMIT 1`,
      )
      .get(tenantId, params.siteId) as typeof existingIncident;
  }

  const upperStatus = params.status.toUpperCase();

  if (existingIncident) {
    const evidence = JSON.parse(existingIncident.rca_evidence_json || '[]') as string[];
    const topoNote =
      upstreamIds.length > 0 || downstreamIds.length > 0
        ? ` [topologia: ${upstreamIds.length} upstream, ${downstreamIds.length} downstream]`
        : '';
    evidence.push(
      `Correlação observada (${params.source}/${params.eventType}: ${params.status})${topoNote} em ${params.observedAtUtc} (hipótese associativa, requer validação).`,
    );

    let nextCategory = existingIncident.rca_category;
    if (
      (existingIncident.rca_category === 'eletrica' && inferredCategory === 'climatica_direta') ||
      (existingIncident.rca_category === 'climatica_direta' && inferredCategory === 'eletrica') ||
      (existingIncident.rca_category !== inferredCategory && inferredCategory !== 'desconhecida' && existingIncident.rca_category !== 'desconhecida')
    ) {
      nextCategory = 'composta';
    } else if (existingIncident.rca_category === 'desconhecida') {
      nextCategory = inferredCategory;
    }

    const nextImpactedCount = Math.max(existingIncident.impacted_services_count ?? 0, impacted.count);
    const nextSeverity =
      nextImpactedCount >= 2 || upperStatus === 'CRITICAL' || upperStatus === 'OUTAGE'
        ? 'CRITICA'
        : existingIncident.severity;

    db.prepare(
      `UPDATE incidents
       SET rca_category = ?, rca_evidence_json = ?, impacted_services_count = ?, severity = ?, rule_version = 'rca-rules-v2.0'
       WHERE id = ? AND tenant_id = ?`,
    ).run(
      nextCategory,
      JSON.stringify(evidence.slice(-25)),
      nextImpactedCount,
      nextSeverity,
      existingIncident.id,
      tenantId,
    );

    db.prepare(
      `INSERT OR IGNORE INTO incident_events (incident_id, event_id, tenant_id, role_in_incident) VALUES (?, ?, ?, 'correlated')`,
    ).run(existingIncident.id, params.eventId, tenantId);

    return { createdIncident: false, incidentId: existingIncident.id };
  }

  const incidentId = crypto.randomUUID();
  const severity =
    impacted.count >= 2 || upperStatus === 'CRITICAL' || upperStatus === 'OUTAGE' ? 'CRITICA' : 'ALTA';

  const initialEvidence: string[] = [
    `Evento inicial ${params.eventId} (${params.source}/${params.eventType}: ${params.status}) observado em ${params.observedAtUtc}.`,
  ];
  if (upstreamIds.length > 0) {
    initialEvidence.push(
      `Grafo topológico identificou ${upstreamIds.length} ativo(s) upstream conectado(s) — verificar dependência antes de confirmar causa raiz.`,
    );
  }
  if (impacted.count > 0) {
    initialEvidence.push(
      `Serviços potencialmente impactados (${impacted.count}): ${impacted.serviceNames.slice(0, 5).join(', ')}.`,
    );
  }

  db.prepare(
    `INSERT INTO incidents (
      id, tenant_id, root_site_id, root_asset_id, title, status, severity,
      impacted_services_count, rca_category, rca_confidence, rca_evidence_json, rule_version, opened_at_utc
    ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, 'rca-rules-v2.0', ?)`,
  ).run(
    incidentId,
    tenantId,
    params.siteId,
    params.assetId,
    `${params.eventType} — ${params.status} (${params.source})`,
    severity,
    impacted.count,
    inferredCategory,
    0.62,
    JSON.stringify(initialEvidence),
    params.eventTimeUtc,
  );

  db.prepare(
    `INSERT OR IGNORE INTO incident_events (incident_id, event_id, tenant_id, role_in_incident) VALUES (?, ?, ?, 'root_trigger')`,
  ).run(incidentId, params.eventId, tenantId);

  return { createdIncident: true, incidentId };
}
