import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { decryptCredentials, validateExternalUrl } from './security.ts';
import { correlateFailureEvent, detectMetricAnomaly } from './correlation.ts';

export interface ConnectorCatalogItem {
  connector_type: string;
  label: string;
  domain: string;
  mode: 'external_api' | 'native_collector' | 'webhook_csv';
  availability: 'READY' | 'REQUIRES_CREDENTIALS' | 'PENDING_EXTERNAL_SPEC';
  description: string;
  required_fields: string[];
  honest_note: string;
}

export const CONNECTOR_CATALOG: ConnectorCatalogItem[] = [
  {
    connector_type: 'open_meteo',
    label: 'Open-Meteo (Clima e Meteorologia)',
    domain: 'ambiente',
    mode: 'external_api',
    availability: 'READY',
    description: 'Consulta real de temperatura, chuva, rajadas de vento e pressão para sites georreferenciados.',
    required_fields: ['sites com coord_verified = 1'],
    honest_note: 'Operacional sem chave externa para sites validados.',
  },
  {
    connector_type: 'zabbix',
    label: 'Zabbix API (TI / Redes / Infra)',
    domain: 'ti',
    mode: 'external_api',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Integração com JSON-RPC API do Zabbix por tenant com token Bearer/API Key cifrado.',
    required_fields: ['endpoint_url', 'credentials'],
    honest_note: 'Status CONFIGURED não comprova conectividade; exige Teste Real e credenciais válidas.',
  },
  {
    connector_type: 'prtg',
    label: 'PRTG Network Monitor',
    domain: 'rede',
    mode: 'external_api',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Coleta de sensores de rede, tráfego e disponibilidade via API autenticada do PRTG.',
    required_fields: ['endpoint_url', 'credentials'],
    honest_note: 'Requer URL acessível e passhash/API key configurados.',
  },
  {
    connector_type: 'slaview',
    label: 'Telcomanager SLAview',
    domain: 'rede',
    mode: 'external_api',
    availability: 'PENDING_EXTERNAL_SPEC',
    description: 'Conector reservado para integração com plataforma SLAview da Telcomanager.',
    required_fields: ['documentacao_api', 'endpoint_url', 'versao', 'auth_mode', 'credentials'],
    honest_note: 'NOT_CONFIGURED — dependência externa pendente de documentação oficial, URL, versão e autenticação. Nenhum endpoint foi inventado.',
  },
  {
    connector_type: 'inmet',
    label: 'INMET (Estações Meteorológicas)',
    domain: 'ambiente',
    mode: 'external_api',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Ingestão de dados de estações automáticas oficiais INMET mediante token.',
    required_fields: ['endpoint_url', 'credentials'],
    honest_note: 'Permanece NOT_CONFIGURED até definição de endpoint e token válido.',
  },
  {
    connector_type: 'cemaden',
    label: 'CEMADEN (Alertas Hidrometeorológicos)',
    domain: 'ambiente',
    mode: 'external_api',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Integração para leitura de alertas pluviométricos e hidrológicos.',
    required_fields: ['endpoint_url'],
    honest_note: 'Requer endpoint oficial configurado.',
  },
  {
    connector_type: 'energy_ups',
    label: 'Energia / UPS / Geradores',
    domain: 'energia',
    mode: 'external_api',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Monitoramento de nobreaks, retificadores, banco de baterias e falha de concessionária.',
    required_fields: ['endpoint_url'],
    honest_note: 'Suporta envio autenticado via webhook ou polling HTTP autorizado.',
  },
  {
    connector_type: 'snmp_v3',
    label: 'SNMPv3 (Coleta Nativa Autorizada)',
    domain: 'rede',
    mode: 'native_collector',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Polling nativo autenticado e cifrado (authPriv) restrito ao escopo CIDR/host aprovado.',
    required_fields: ['authorized_collection_scope'],
    honest_note: 'Nunca executa varredura sem escopo explicitamente cadastrado e auditado.',
  },
  {
    connector_type: 'snmp_trap',
    label: 'SNMP Trap Receiver',
    domain: 'rede',
    mode: 'native_collector',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Recepção de traps assíncronos normalizados em eventos canônicos.',
    required_fields: ['authorized_collection_scope'],
    honest_note: 'Requer coletor Python em rede interna com escopo autorizado.',
  },
  {
    connector_type: 'mqtt',
    label: 'MQTT / TLS (IoT & Sensores)',
    domain: 'iot',
    mode: 'native_collector',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Assinatura de tópicos IoT de sensores ambientais, temperatura, umidade e energia.',
    required_fields: ['authorized_collection_scope'],
    honest_note: 'Ingestão aceita apenas para origens/tópicos em escopo autorizado.',
  },
  {
    connector_type: 'icmp',
    label: 'ICMP Probe (Latência & Perda)',
    domain: 'rede',
    mode: 'native_collector',
    availability: 'REQUIRES_CREDENTIALS',
    description: 'Sondas de RTT e perda de pacotes exclusivamente em IPs/CIDRs autorizados.',
    required_fields: ['authorized_collection_scope'],
    honest_note: 'Proibido contra alvos fora de authorized_collection_scopes.',
  },
  {
    connector_type: 'otlp',
    label: 'OpenTelemetry / OTLP (TI & Aplicações)',
    domain: 'ti',
    mode: 'native_collector',
    availability: 'READY',
    description: 'Receptor HTTP/JSON para métricas e logs OTLP de servidores, bancos e aplicações.',
    required_fields: ['authorized_collection_scope'],
    honest_note: 'Requer registro da origem OTLP no escopo autorizado do tenant.',
  },
  {
    connector_type: 'webhook_csv',
    label: 'Webhook Autenticado & CSV Incremental',
    domain: 'ti',
    mode: 'webhook_csv',
    availability: 'READY',
    description: 'Ingestão direta de eventos, métricas ou logs e importação CSV incremental com checkpoints.',
    required_fields: [],
    honest_note: 'Operacional com deduplicação idempotente e retomada por checkpoint.',
  },
];

export interface CepLookupResult {
  cep: string;
  address: string;
  neighborhood: string;
  municipality: string;
  uf: string;
  source: 'brasilapi' | 'viacep';
  coordinates_note: string;
}

export async function lookupCepAddress(rawCep: string): Promise<CepLookupResult> {
  const digits = rawCep.replace(/\D/g, '');
  if (digits.length !== 8) {
    throw new Error('CEP inválido. Informe exatamente 8 dígitos.');
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(`https://brasilapi.com.br/api/cep/v2/${digits}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = (await resp.json()) as {
        cep?: string;
        street?: string;
        neighborhood?: string;
        city?: string;
        state?: string;
      };
      return {
        cep: data.cep ?? digits,
        address: data.street ?? '',
        neighborhood: data.neighborhood ?? '',
        municipality: data.city ?? '',
        uf: data.state ?? '',
        source: 'brasilapi',
        coordinates_note:
          'CEP resolve apenas endereço postal. Latitude e longitude exigem geocodificação ou verificação manual.',
      };
    }
  } catch {
    // Fallback para ViaCEP
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch(`https://viacep.com.br/ws/${digits}/json/`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      throw new Error(`ViaCEP retornou HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
      erro?: boolean;
      cep?: string;
      logradouro?: string;
      bairro?: string;
      localidade?: string;
      uf?: string;
    };
    if (data.erro) {
      throw new Error('CEP não encontrado na base oficial.');
    }
    return {
      cep: data.cep ?? digits,
      address: data.logradouro ?? '',
      neighborhood: data.bairro ?? '',
      municipality: data.localidade ?? '',
      uf: data.uf ?? '',
      source: 'viacep',
      coordinates_note:
        'CEP resolve apenas endereço postal. Latitude e longitude exigem geocodificação ou verificação manual.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function geocodeAddressNominatim(query: {
  address?: string;
  municipality: string;
  uf: string;
}): Promise<{ latitude: number; longitude: number; display_name: string; precision: 'geocodificada' } | null> {
  const parts = [query.address, query.municipality, query.uf, 'Brasil'].filter(Boolean);
  if (parts.length < 2) return null;

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', parts.join(', '));
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '1');
  url.searchParams.set('countrycodes', 'br');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'AIOps-Intelligence-Platform/1.0 (NOC-Geocoding)',
      },
    });
    if (!resp.ok) {
      throw new Error(`Nominatim retornou HTTP ${resp.status}`);
    }
    const results = (await resp.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    if (!results.length) return null;
    const lat = Number(results[0].lat);
    const lon = Number(results[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      latitude: lat,
      longitude: lon,
      display_name: results[0].display_name,
      precision: 'geocodificada',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface ConnectorRow {
  id: string;
  tenant_id: string;
  connector_type: string;
  name: string;
  endpoint_url: string | null;
  auth_mode: string;
  encrypted_credentials: string | null;
  config_json: string;
}

export async function testConnectorConnectivity(
  connector: ConnectorRow,
): Promise<{ ok: boolean; latency_ms: number; status_code?: number; detail: string }> {
  const start = Date.now();

  if (connector.connector_type === 'slaview' && !connector.endpoint_url) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail:
        'NOT_CONFIGURED: Integração Telcomanager SLAview pendente de documentação oficial, URL, versão e credenciais.',
    };
  }

  if (connector.connector_type === 'open_meteo') {
    const target =
      connector.endpoint_url ||
      'https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m';
    const ssrf = validateExternalUrl(target);
    if (!ssrf.ok) {
      return { ok: false, latency_ms: Date.now() - start, detail: ssrf.reason ?? 'URL bloqueada' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(ssrf.parsedUrl!.toString(), { signal: controller.signal });
      const latency_ms = Date.now() - start;
      if (!resp.ok) {
        return { ok: false, latency_ms, status_code: resp.status, detail: `Open-Meteo retornou HTTP ${resp.status}` };
      }
      return { ok: true, latency_ms, status_code: resp.status, detail: 'Conexão verificada com Open-Meteo API.' };
    } catch (err) {
      return {
        ok: false,
        latency_ms: Date.now() - start,
        detail: err instanceof Error ? err.message : 'Falha de rede ao consultar Open-Meteo',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (connector.connector_type === 'webhook_csv' || connector.connector_type === 'otlp') {
    return {
      ok: true,
      latency_ms: Date.now() - start,
      detail:
        connector.connector_type === 'otlp'
          ? 'Receptor OTLP autenticado ativo (requer escopo autorizado em Coleta Nativa).'
          : 'Receptor local autenticado ativo (pronto para ingestão via POST /ingest ou CSV incremental).',
    };
  }

  if (!connector.endpoint_url) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: 'Conector sem endpoint_url configurado (NOT_CONFIGURED).',
    };
  }

  const ssrf = validateExternalUrl(connector.endpoint_url);
  if (!ssrf.ok) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: ssrf.reason ?? 'Endpoint bloqueado pela política anti-SSRF.',
    };
  }

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (connector.encrypted_credentials) {
    try {
      const secret = decryptCredentials(connector.encrypted_credentials);
      if (connector.auth_mode === 'bearer') headers.Authorization = `Bearer ${secret}`;
      if (connector.auth_mode === 'api_key') headers['X-API-Key'] = secret;
      if (connector.auth_mode === 'basic') headers.Authorization = `Basic ${Buffer.from(secret).toString('base64')}`;
    } catch {
      return { ok: false, latency_ms: Date.now() - start, detail: 'Falha ao decifrar credenciais armazenadas.' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const resp = await fetch(ssrf.parsedUrl!.toString(), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latency_ms = Date.now() - start;
    if (!resp.ok) {
      return {
        ok: false,
        latency_ms,
        status_code: resp.status,
        detail: `Endpoint respondeu HTTP ${resp.status}. Verifique credenciais ou caminho da API.`,
      };
    }
    return {
      ok: true,
      latency_ms,
      status_code: resp.status,
      detail: `Conectividade confirmada (HTTP ${resp.status}).`,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : 'Timeout ou erro de rede ao testar conector.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface IngestEventInput {
  idempotency_key: string;
  site_id?: string | null;
  asset_id?: string | null;
  event_time_utc: string;
  observed_at_utc: string;
  forecast_issued_at_utc?: string | null;
  source: string;
  event_type: string;
  status: string;
  lat?: number | null;
  lon?: number | null;
  quality_flag?: 'VALID' | 'STALE' | 'SUSPECT' | 'UNVERIFIED_COORDS';
  payload?: Record<string, unknown>;
}

export interface IngestMetricInput {
  idempotency_key: string;
  asset_id?: string | null;
  service_id?: string | null;
  site_id?: string | null;
  metric_name: string;
  value_num: number;
  unit: string;
  observed_at_utc: string;
  source: string;
  quality_flag?: 'VALID' | 'STALE' | 'SUSPECT' | 'UNVERIFIED_COORDS';
  tags?: Record<string, unknown>;
}

export interface IngestLogInput {
  idempotency_key: string;
  asset_id?: string | null;
  service_id?: string | null;
  site_id?: string | null;
  severity: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  message: string;
  observed_at_utc: string;
  source: string;
  trace_id?: string | null;
  attributes?: Record<string, unknown>;
}

/**
 * Persiste eventos canônicos idempotentemente dentro de um único tenant
 * e correlaciona falhas (DOWN / OUTAGE / CRITICAL) via grafo topológico e serviços.
 */
export function ingestCanonicalEvents(
  db: Database.Database,
  tenantId: string,
  connectorId: string | null,
  events: IngestEventInput[],
): { ingested: number; deduplicated: number; created_incidents: number } {
  const now = new Date().toISOString();
  let ingested = 0;
  let deduplicated = 0;
  let createdIncidents = 0;

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO canonical_events (
      id, tenant_id, site_id, asset_id, connector_id, idempotency_key,
      event_time_utc, observed_at_utc, ingested_at_utc, forecast_issued_at_utc,
      source, event_type, status, lat, lon, quality_flag, payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkSite = db.prepare(`SELECT id, name, latitude, longitude, coord_verified FROM sites WHERE id = ? AND tenant_id = ?`);
  const checkAsset = db.prepare(`SELECT id, site_id, name, domain FROM assets WHERE id = ? AND tenant_id = ?`);

  const trx = db.transaction(() => {
    for (const ev of events) {
      let validSiteId: string | null = null;
      let validAssetId: string | null = null;
      let assetDomain: string | null = null;
      let lat = ev.lat ?? null;
      let lon = ev.lon ?? null;
      let qualityFlag = ev.quality_flag ?? 'VALID';

      if (ev.asset_id) {
        const asset = checkAsset.get(ev.asset_id, tenantId) as
          | { id: string; site_id: string | null; name: string; domain: string }
          | undefined;
        if (asset) {
          validAssetId = asset.id;
          validSiteId = asset.site_id;
          assetDomain = asset.domain;
        }
      }

      if (!validSiteId && ev.site_id) {
        const site = checkSite.get(ev.site_id, tenantId) as
          | { id: string; name: string; latitude: number | null; longitude: number | null; coord_verified: number }
          | undefined;
        if (site) {
          validSiteId = site.id;
          if (lat == null && site.latitude != null) lat = site.latitude;
          if (lon == null && site.longitude != null) lon = site.longitude;
          if (!site.coord_verified && qualityFlag === 'VALID') {
            qualityFlag = 'UNVERIFIED_COORDS';
          }
        }
      }

      const eventId = crypto.randomUUID();
      const info = insertEvent.run(
        eventId,
        tenantId,
        validSiteId,
        validAssetId,
        connectorId,
        ev.idempotency_key,
        ev.event_time_utc,
        ev.observed_at_utc,
        now,
        ev.forecast_issued_at_utc ?? null,
        ev.source,
        ev.event_type,
        ev.status,
        lat,
        lon,
        qualityFlag,
        JSON.stringify(ev.payload ?? {}),
      );

      if (info.changes === 0) {
        deduplicated += 1;
        continue;
      }
      ingested += 1;

      const upperStatus = ev.status.toUpperCase();
      if (['DOWN', 'OUTAGE', 'CRITICAL', 'POWER_LOSS'].includes(upperStatus)) {
        const corr = correlateFailureEvent(db, tenantId, {
          eventId,
          siteId: validSiteId,
          assetId: validAssetId,
          assetDomain,
          source: ev.source,
          eventType: ev.event_type,
          status: ev.status,
          observedAtUtc: ev.observed_at_utc,
          eventTimeUtc: ev.event_time_utc,
        });
        if (corr.createdIncident) {
          createdIncidents += 1;
        }
      }

      if (validAssetId) {
        const mappedState = ['DOWN', 'OUTAGE', 'CRITICAL'].includes(upperStatus)
          ? 'DOWN'
          : ['DEGRADED', 'WARNING'].includes(upperStatus)
            ? 'DEGRADED'
            : ['UP', 'OK', 'NORMAL'].includes(upperStatus)
              ? 'UP'
              : null;
        if (mappedState) {
          db.prepare(`UPDATE assets SET operational_state = ?, updated_at_utc = ? WHERE id = ? AND tenant_id = ?`).run(
            mappedState,
            now,
            validAssetId,
            tenantId,
          );
        }
      }
    }
  });

  trx();
  return { ingested, deduplicated, created_incidents: createdIncidents };
}

/**
 * Ingere amostras de séries temporais separadas de eventos genéricos
 * e executa detector estatístico Z-Score (>= 5 amostras prévias).
 */
export function ingestMetricSamples(
  db: Database.Database,
  tenantId: string,
  connectorId: string | null,
  samples: IngestMetricInput[],
): { ingested: number; deduplicated: number; anomalies_detected: number } {
  const now = new Date().toISOString();
  let ingested = 0;
  let deduplicated = 0;
  let anomaliesDetected = 0;

  const insertMetric = db.prepare(`
    INSERT OR IGNORE INTO metric_samples (
      id, tenant_id, asset_id, service_id, site_id, connector_id, idempotency_key,
      metric_name, value_num, unit, observed_at_utc, ingested_at_utc, source, quality_flag, tags_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkAsset = db.prepare('SELECT id, site_id FROM assets WHERE id = ? AND tenant_id = ?');
  const checkService = db.prepare('SELECT id FROM services WHERE id = ? AND tenant_id = ?');
  const checkSite = db.prepare('SELECT id FROM sites WHERE id = ? AND tenant_id = ?');

  const trx = db.transaction(() => {
    for (const s of samples) {
      let validAssetId: string | null = null;
      let validServiceId: string | null = null;
      let validSiteId: string | null = null;

      if (s.asset_id) {
        const a = checkAsset.get(s.asset_id, tenantId) as { id: string; site_id: string | null } | undefined;
        if (a) {
          validAssetId = a.id;
          validSiteId = a.site_id;
        }
      }
      if (s.service_id && checkService.get(s.service_id, tenantId)) {
        validServiceId = s.service_id;
      }
      if (!validSiteId && s.site_id && checkSite.get(s.site_id, tenantId)) {
        validSiteId = s.site_id;
      }

      const id = crypto.randomUUID();
      const info = insertMetric.run(
        id,
        tenantId,
        validAssetId,
        validServiceId,
        validSiteId,
        connectorId,
        s.idempotency_key,
        s.metric_name.trim(),
        Number(s.value_num),
        s.unit.trim() || 'unit',
        s.observed_at_utc,
        now,
        s.source.trim(),
        s.quality_flag ?? 'VALID',
        JSON.stringify(s.tags ?? {}),
      );

      if (info.changes === 0) {
        deduplicated += 1;
        continue;
      }
      ingested += 1;

      const anomaly = detectMetricAnomaly(db, tenantId, {
        asset_id: validAssetId,
        service_id: validServiceId,
        metric_name: s.metric_name.trim(),
        value_num: Number(s.value_num),
        observed_at_utc: s.observed_at_utc,
      });
      if (anomaly.detected) {
        anomaliesDetected += 1;
      }
    }
  });

  trx();
  return { ingested, deduplicated, anomalies_detected: anomaliesDetected };
}

/**
 * Ingere logs operacionais estruturados idempotentemente.
 */
export function ingestOperationalLogs(
  db: Database.Database,
  tenantId: string,
  connectorId: string | null,
  logs: IngestLogInput[],
): { ingested: number; deduplicated: number } {
  const now = new Date().toISOString();
  let ingested = 0;
  let deduplicated = 0;

  const insertLog = db.prepare(`
    INSERT OR IGNORE INTO operational_logs (
      id, tenant_id, asset_id, service_id, site_id, connector_id, idempotency_key,
      severity, message, observed_at_utc, ingested_at_utc, source, trace_id, attributes_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const checkAsset = db.prepare('SELECT id, site_id FROM assets WHERE id = ? AND tenant_id = ?');
  const checkService = db.prepare('SELECT id FROM services WHERE id = ? AND tenant_id = ?');

  const trx = db.transaction(() => {
    for (const l of logs) {
      let validAssetId: string | null = null;
      let validServiceId: string | null = null;
      let validSiteId: string | null = l.site_id ?? null;

      if (l.asset_id) {
        const a = checkAsset.get(l.asset_id, tenantId) as { id: string; site_id: string | null } | undefined;
        if (a) {
          validAssetId = a.id;
          validSiteId = validSiteId ?? a.site_id;
        }
      }
      if (l.service_id && checkService.get(l.service_id, tenantId)) {
        validServiceId = l.service_id;
      }

      const sev = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'].includes(l.severity) ? l.severity : 'INFO';
      const info = insertLog.run(
        crypto.randomUUID(),
        tenantId,
        validAssetId,
        validServiceId,
        validSiteId,
        connectorId,
        l.idempotency_key,
        sev,
        l.message,
        l.observed_at_utc,
        now,
        l.source,
        l.trace_id ?? null,
        JSON.stringify(l.attributes ?? {}),
      );

      if (info.changes === 0) {
        deduplicated += 1;
      } else {
        ingested += 1;
      }
    }
  });

  trx();
  return { ingested, deduplicated };
}

function parseCsvRow(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if ((ch === ',' || ch === ';') && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Ingestão CSV incremental com retomada por checkpoint (`ingestion_checkpoints`),
 * validação de contrato, deduplicação por hash/idempotency_key e auditoria.
 */
export function ingestCsvIncrementalWithCheckpoint(
  db: Database.Database,
  tenantId: string,
  connectorId: string,
  input: {
    csv_text: string;
    kind: 'metrics' | 'events' | 'logs';
    cursor_key: string;
    resume_from_checkpoint?: boolean;
    batch_limit?: number;
  },
): {
  kind: 'metrics' | 'events' | 'logs';
  cursor_key: string;
  resumed_from_row: number;
  total_data_rows: number;
  rows_processed_now: number;
  cumulative_rows_processed: number;
  ingested: number;
  deduplicated: number;
  anomalies_detected: number;
  created_incidents: number;
  invalid_rows: number;
  status: 'IN_PROGRESS' | 'COMPLETED';
} {
  const rawLines = input.csv_text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (rawLines.length < 2) {
    throw new Error('CSV deve conter cabeçalho e pelo menos 1 linha de dados.');
  }

  const headers = parseCsvRow(rawLines[0]).map((h) => h.toLowerCase());
  const dataLines = rawLines.slice(1);

  const existingCheckpoint = db
    .prepare('SELECT rows_processed, bytes_processed FROM ingestion_checkpoints WHERE tenant_id = ? AND connector_id = ? AND cursor_key = ?')
    .get(tenantId, connectorId, input.cursor_key) as { rows_processed: number; bytes_processed: number } | undefined;

  const startOffset = input.resume_from_checkpoint && existingCheckpoint ? existingCheckpoint.rows_processed : 0;
  const limit = Math.max(1, Math.min(5000, Number(input.batch_limit || 2000)));
  const slice = dataLines.slice(startOffset, startOffset + limit);

  let invalidRows = 0;
  let ingested = 0;
  let deduplicated = 0;
  let anomaliesDetected = 0;
  let createdIncidents = 0;

  const getVal = (row: string[], col: string): string => {
    const idx = headers.indexOf(col);
    return idx >= 0 ? (row[idx] ?? '') : '';
  };

  if (input.kind === 'metrics') {
    const samples: IngestMetricInput[] = [];
    for (let i = 0; i < slice.length; i++) {
      const cols = parseCsvRow(slice[i]);
      const metricName = getVal(cols, 'metric_name') || getVal(cols, 'metric');
      const valueNum = Number(getVal(cols, 'value_num') || getVal(cols, 'value'));
      const observedAt = getVal(cols, 'observed_at_utc') || getVal(cols, 'timestamp');
      if (!metricName || !Number.isFinite(valueNum) || !observedAt) {
        invalidRows += 1;
        continue;
      }
      const assetId = getVal(cols, 'asset_id') || null;
      const serviceId = getVal(cols, 'service_id') || null;
      const key =
        getVal(cols, 'idempotency_key') ||
        `csv:${input.cursor_key}:${assetId ?? serviceId ?? 'global'}:${metricName}:${observedAt}:${valueNum}`;
      samples.push({
        idempotency_key: key,
        asset_id: assetId,
        service_id: serviceId,
        site_id: getVal(cols, 'site_id') || null,
        metric_name: metricName,
        value_num: valueNum,
        unit: getVal(cols, 'unit') || 'unit',
        observed_at_utc: observedAt,
        source: getVal(cols, 'source') || 'csv_incremental',
      });
    }
    const res = ingestMetricSamples(db, tenantId, connectorId, samples);
    ingested = res.ingested;
    deduplicated = res.deduplicated;
    anomaliesDetected = res.anomalies_detected;
  } else if (input.kind === 'logs') {
    const logs: IngestLogInput[] = [];
    for (let i = 0; i < slice.length; i++) {
      const cols = parseCsvRow(slice[i]);
      const message = getVal(cols, 'message');
      const observedAt = getVal(cols, 'observed_at_utc') || getVal(cols, 'timestamp');
      if (!message || !observedAt) {
        invalidRows += 1;
        continue;
      }
      const sev = (getVal(cols, 'severity') || 'INFO').toUpperCase() as IngestLogInput['severity'];
      const key =
        getVal(cols, 'idempotency_key') ||
        `csvlog:${input.cursor_key}:${observedAt}:${crypto.createHash('sha1').update(message).digest('hex').slice(0, 12)}`;
      logs.push({
        idempotency_key: key,
        asset_id: getVal(cols, 'asset_id') || null,
        service_id: getVal(cols, 'service_id') || null,
        site_id: getVal(cols, 'site_id') || null,
        severity: sev,
        message,
        observed_at_utc: observedAt,
        source: getVal(cols, 'source') || 'csv_incremental',
        trace_id: getVal(cols, 'trace_id') || null,
      });
    }
    const res = ingestOperationalLogs(db, tenantId, connectorId, logs);
    ingested = res.ingested;
    deduplicated = res.deduplicated;
  } else {
    const events: IngestEventInput[] = [];
    for (let i = 0; i < slice.length; i++) {
      const cols = parseCsvRow(slice[i]);
      const eventType = getVal(cols, 'event_type');
      const status = getVal(cols, 'status');
      const observedAt = getVal(cols, 'observed_at_utc') || getVal(cols, 'event_time_utc');
      if (!eventType || !status || !observedAt) {
        invalidRows += 1;
        continue;
      }
      const eventTime = getVal(cols, 'event_time_utc') || observedAt;
      const key =
        getVal(cols, 'idempotency_key') || `csvev:${input.cursor_key}:${startOffset + i}:${eventType}:${observedAt}`;
      events.push({
        idempotency_key: key,
        site_id: getVal(cols, 'site_id') || null,
        asset_id: getVal(cols, 'asset_id') || null,
        event_time_utc: eventTime,
        observed_at_utc: observedAt,
        source: getVal(cols, 'source') || 'csv_incremental',
        event_type: eventType,
        status,
      });
    }
    const res = ingestCanonicalEvents(db, tenantId, connectorId, events);
    ingested = res.ingested;
    deduplicated = res.deduplicated;
    createdIncidents = res.created_incidents;
  }

  const cumulative = startOffset + slice.length;
  const finalStatus: 'IN_PROGRESS' | 'COMPLETED' = cumulative >= dataLines.length ? 'COMPLETED' : 'IN_PROGRESS';
  const bytesProcessed = Buffer.byteLength(slice.join('\n'), 'utf8');
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO ingestion_checkpoints (
      id, tenant_id, connector_id, cursor_key, cursor_value, rows_processed, bytes_processed, status, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, connector_id, cursor_key) DO UPDATE SET
      cursor_value = excluded.cursor_value,
      rows_processed = excluded.rows_processed,
      bytes_processed = ingestion_checkpoints.bytes_processed + excluded.bytes_processed,
      status = excluded.status,
      updated_at_utc = excluded.updated_at_utc`,
  ).run(
    crypto.randomUUID(),
    tenantId,
    connectorId,
    input.cursor_key,
    String(cumulative),
    cumulative,
    bytesProcessed,
    finalStatus,
    now,
  );

  return {
    kind: input.kind,
    cursor_key: input.cursor_key,
    resumed_from_row: startOffset,
    total_data_rows: dataLines.length,
    rows_processed_now: slice.length,
    cumulative_rows_processed: cumulative,
    ingested,
    deduplicated,
    anomalies_detected: anomaliesDetected,
    created_incidents: createdIncidents,
    invalid_rows: invalidRows,
    status: finalStatus,
  };
}

/**
 * Sincronização real com Open-Meteo para sites com coordenadas verificadas do tenant.
 * Emite tanto eventos canônicos quanto séries temporais normalizadas em `metric_samples`.
 */
export async function syncOpenMeteoForTenant(
  db: Database.Database,
  tenantId: string,
  connectorId: string,
): Promise<{
  status: 'SUCCESS' | 'PARTIAL' | 'ERROR';
  records_ingested: number;
  records_deduplicated: number;
  latency_ms: number;
  error_message: string | null;
}> {
  const start = Date.now();
  const sites = db
    .prepare(
      `SELECT id, code, name, latitude, longitude FROM sites WHERE tenant_id = ? AND coord_verified = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    )
    .all(tenantId) as Array<{ id: string; code: string; name: string; latitude: number; longitude: number }>;

  if (sites.length === 0) {
    return {
      status: 'ERROR',
      records_ingested: 0,
      records_deduplicated: 0,
      latency_ms: Date.now() - start,
      error_message:
        'Nenhum site com coordenadas verificadas encontrado neste tenant. Cadastre e valide coordenadas antes de sincronizar Open-Meteo.',
    };
  }

  let totalIngested = 0;
  let totalDeduplicated = 0;
  const errors: string[] = [];

  for (const site of sites.slice(0, 25)) {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(site.latitude));
    url.searchParams.set('longitude', String(site.longitude));
    url.searchParams.set('current', 'temperature_2m,precipitation,rain,wind_speed_10m,wind_gusts_10m,surface_pressure');
    url.searchParams.set('hourly', 'precipitation,wind_gusts_10m,surface_pressure');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'UTC');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    try {
      const resp = await fetch(url.toString(), { signal: controller.signal });
      if (!resp.ok) {
        errors.push(`${site.code}: HTTP ${resp.status}`);
        continue;
      }
      const data = (await resp.json()) as {
        current?: {
          time: string;
          temperature_2m?: number;
          precipitation?: number;
          rain?: number;
          wind_speed_10m?: number;
          wind_gusts_10m?: number;
          surface_pressure?: number;
        };
      };
      if (!data.current?.time) {
        errors.push(`${site.code}: resposta Open-Meteo sem bloco current`);
        continue;
      }
      const observedUtc = data.current.time.endsWith('Z') ? data.current.time : `${data.current.time}:00Z`;
      const issuedUtc = new Date().toISOString();
      const precip = Number(data.current.precipitation ?? 0);
      const gusts = Number(data.current.wind_gusts_10m ?? 0);
      const status = precip >= 15 || gusts >= 65 ? 'WARNING' : 'NORMAL';

      const evRes = ingestCanonicalEvents(db, tenantId, connectorId, [
        {
          idempotency_key: `open_meteo:${site.id}:${observedUtc}`,
          site_id: site.id,
          event_time_utc: observedUtc,
          observed_at_utc: observedUtc,
          forecast_issued_at_utc: issuedUtc,
          source: 'open_meteo',
          event_type: 'weather_observation',
          status,
          lat: site.latitude,
          lon: site.longitude,
          quality_flag: 'VALID',
          payload: data.current as unknown as Record<string, unknown>,
        },
      ]);

      // Separação explícita de séries temporais numéricas em metric_samples
      const metricBatch: IngestMetricInput[] = [];
      if (data.current.temperature_2m != null) {
        metricBatch.push({
          idempotency_key: `open_meteo_m:${site.id}:temperature_2m:${observedUtc}`,
          site_id: site.id,
          metric_name: 'weather_temperature_2m',
          value_num: Number(data.current.temperature_2m),
          unit: '°C',
          observed_at_utc: observedUtc,
          source: 'open_meteo',
        });
      }
      if (data.current.precipitation != null) {
        metricBatch.push({
          idempotency_key: `open_meteo_m:${site.id}:precipitation:${observedUtc}`,
          site_id: site.id,
          metric_name: 'weather_precipitation',
          value_num: Number(data.current.precipitation),
          unit: 'mm',
          observed_at_utc: observedUtc,
          source: 'open_meteo',
        });
      }
      if (data.current.wind_gusts_10m != null) {
        metricBatch.push({
          idempotency_key: `open_meteo_m:${site.id}:wind_gusts_10m:${observedUtc}`,
          site_id: site.id,
          metric_name: 'weather_wind_gusts_10m',
          value_num: Number(data.current.wind_gusts_10m),
          unit: 'km/h',
          observed_at_utc: observedUtc,
          source: 'open_meteo',
        });
      }
      if (data.current.surface_pressure != null) {
        metricBatch.push({
          idempotency_key: `open_meteo_m:${site.id}:surface_pressure:${observedUtc}`,
          site_id: site.id,
          metric_name: 'weather_surface_pressure',
          value_num: Number(data.current.surface_pressure),
          unit: 'hPa',
          observed_at_utc: observedUtc,
          source: 'open_meteo',
        });
      }
      if (metricBatch.length > 0) {
        ingestMetricSamples(db, tenantId, connectorId, metricBatch);
      }

      totalIngested += evRes.ingested;
      totalDeduplicated += evRes.deduplicated;
    } catch (err) {
      errors.push(`${site.code}: ${err instanceof Error ? err.message : 'erro de rede'}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const latency_ms = Date.now() - start;
  const status = errors.length === 0 ? 'SUCCESS' : totalIngested > 0 || totalDeduplicated > 0 ? 'PARTIAL' : 'ERROR';
  return {
    status,
    records_ingested: totalIngested,
    records_deduplicated: totalDeduplicated,
    latency_ms,
    error_message: errors.length ? errors.join('; ') : null,
  };
}
