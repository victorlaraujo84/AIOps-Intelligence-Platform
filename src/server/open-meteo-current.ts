import { getOutboundHttps } from './outbound-http.ts';

const variables = ['temperature_2m', 'precipitation', 'wind_gusts_10m', 'surface_pressure'] as const;
type Readings = Record<typeof variables[number], number>;
type Result =
  | { observed_at: string; readings: Readings }
  | { failure: 'UPSTREAM_UNAVAILABLE' | 'UPSTREAM_INVALID' };

function parseCurrent(data: unknown): Result {
  const invalid = { failure: 'UPSTREAM_INVALID' } as const;
  if (!data || typeof data !== 'object' || !('current' in data) || !data.current || typeof data.current !== 'object') {
    return invalid;
  }
  const current = data.current as Record<string, unknown>;
  if (!Number.isSafeInteger(current.time) || Number(current.time) < 1 || Number(current.time) > 253402300799) {
    return invalid;
  }
  for (const key of variables) {
    if (typeof current[key] !== 'number' || !Number.isFinite(current[key])) return invalid;
  }
  const readings = Object.fromEntries(variables.map(key => [key, current[key]])) as Readings;
  return { observed_at: new Date(Number(current.time) * 1000).toISOString(), readings };
}

export async function getOpenMeteoCurrent(
  latitude: number, longitude: number, transport = getOutboundHttps,
): Promise<Result> {
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90
      || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    return { failure: 'UPSTREAM_INVALID' };
  }
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    current: variables.join(','),
    temperature_unit: 'celsius',
    precipitation_unit: 'mm',
    wind_speed_unit: 'kmh',
    timeformat: 'unixtime',
    timezone: 'UTC',
    forecast_days: '1',
  }).toString();
  let response: Awaited<ReturnType<typeof getOutboundHttps>>;
  try {
    response = await transport(url.href, { timeoutMs: 4500 });
  } catch {
    return { failure: 'UPSTREAM_UNAVAILABLE' };
  }
  if (!response.ok) return { failure: 'UPSTREAM_UNAVAILABLE' };
  try {
    return parseCurrent(response.json());
  } catch {
    return { failure: 'UPSTREAM_INVALID' };
  }
}
