import type Database from 'better-sqlite3';
import crypto from 'node:crypto';
import { decryptCredentials, validateExternalUrl } from './security.ts';
import type { RcaCategory } from '../shared/types.ts';

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

  // Tentativa 1: BrasilAPI
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

  // Tentativa 2: ViaCEP
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

  if (connector.connector_type === 'open_meteo') {
    const target = connector.endpoint_url || 'https://api.open-meteo.com/v1/forecast?latitude=-23.55&longitude=-46.63&current=temperature_2m';
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

  if (connector.connector_type === 'webhook_csv') {
    return {
      ok: true,
      latency_ms: Date.now() - start,
      detail: 'Receptor local autenticado ativo (pronto para ingestão via POST /api/integrations/connectors/:id/ingest).',
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

/**
 * Persiste eventos canônicos idempotentemente dentro de um único tenant
 * e correlaciona eventos de falha (DOWN / OUTAGE / CRITICAL) em incidentes com RCA determinístico.
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
  const checkAsset = db.prepare(`SELECT id, site_id, name FROM assets WHERE id = ? AND tenant_id = ?`);

  const trx = db.transaction(() => {
    for (const ev of events) {
      let validSiteId: string | null = null;
      let validAssetId: string | null = null;
      let lat = ev.lat ?? null;
      let lon = ev.lon ?? null;
      let qualityFlag = ev.quality_flag ?? 'VALID';

      if (ev.asset_id) {
        const asset = checkAsset.get(ev.asset_id, tenantId) as { id: string; site_id: string; name: string } | undefined;
        if (asset) {
          validAssetId = asset.id;
          validSiteId = asset.site_id;
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
        // Correlação determinística simples por site + janela aberta
        const existingIncident = validSiteId
          ? (db
              .prepare(
                `SELECT id, rca_category, rca_evidence_json FROM incidents WHERE tenant_id = ? AND root_site_id = ? AND status != 'RESOLVED' ORDER BY opened_at_utc DESC LIMIT 1`,
              )
              .get(tenantId, validSiteId) as
              | { id: string; rca_category: RcaCategory; rca_evidence_json: string }
              | undefined)
          : undefined;

        const inferredCategory: RcaCategory = ev.event_type.includes('power') || ev.event_type.includes('ups')
          ? 'eletrica'
          : ev.event_type.includes('weather') || ev.event_type.includes('rain') || ev.event_type.includes('wind')
            ? 'climatica_direta'
            : ev.event_type.includes('network') || ev.event_type.includes('link') || ev.event_type.includes('icmp')
              ? 'telecom_outros'
              : 'desconhecida';

        if (existingIncident) {
          const evidence = JSON.parse(existingIncident.rca_evidence_json) as string[];
          evidence.push(`Evento correlacionado (${ev.source}/${ev.event_type}: ${ev.status}) em ${ev.observed_at_utc}`);
          let nextCategory = existingIncident.rca_category;
          if (
            (existingIncident.rca_category === 'eletrica' && inferredCategory === 'climatica_direta') ||
            (existingIncident.rca_category === 'climatica_direta' && inferredCategory === 'eletrica')
          ) {
            nextCategory = 'composta';
          }
          db.prepare(`UPDATE incidents SET rca_category = ?, rca_evidence_json = ? WHERE id = ? AND tenant_id = ?`).run(
            nextCategory,
            JSON.stringify(evidence.slice(-20)),
            existingIncident.id,
            tenantId,
          );
          db.prepare(
            `INSERT OR IGNORE INTO incident_events (incident_id, event_id, tenant_id, role_in_incident) VALUES (?, ?, ?, 'correlated')`,
          ).run(existingIncident.id, eventId, tenantId);
        } else {
          const incidentId = crypto.randomUUID();
          const severity = upperStatus === 'CRITICAL' || upperStatus === 'OUTAGE' ? 'CRITICA' : 'ALTA';
          db.prepare(`
            INSERT INTO incidents (
              id, tenant_id, root_site_id, root_asset_id, title, status, severity,
              rca_category, rca_confidence, rca_evidence_json, rule_version, opened_at_utc
            ) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, 'rca-rules-v1.0', ?)
          `).run(
            incidentId,
            tenantId,
            validSiteId,
            validAssetId,
            `${ev.event_type} — ${ev.status} (${ev.source})`,
            severity,
            inferredCategory,
            0.65,
            JSON.stringify([`Evento inicial ${eventId} observado em ${ev.observed_at_utc}`]),
            ev.event_time_utc,
          );
          db.prepare(
            `INSERT OR IGNORE INTO incident_events (incident_id, event_id, tenant_id, role_in_incident) VALUES (?, ?, ?, 'root_trigger')`,
          ).run(incidentId, eventId, tenantId);
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
 * Sincronização real com Open-Meteo para sites com coordenadas verificadas do tenant.
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

      const res = ingestCanonicalEvents(db, tenantId, connectorId, [
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
      totalIngested += res.ingested;
      totalDeduplicated += res.deduplicated;
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
