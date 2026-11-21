import assert from 'node:assert/strict';
import test from 'node:test';
import { getOpenMeteoCurrent } from '../../src/server/open-meteo-current.ts';

const readings = { temperature_2m: 12.5, precipitation: 0, wind_gusts_10m: 23, surface_pressure: 1000 };

test('consulta a origem fixa e preserva zero e horário do fornecedor', async () => {
  const response = await getOpenMeteoCurrent(52.52, 13.41, async address => {
    const url = new URL(address);
    assert.equal(url.origin, 'https://api.open-meteo.com');
    assert.equal(url.pathname, '/v1/forecast');
    assert.equal(url.searchParams.get('latitude'), '52.52');
    assert.equal(url.searchParams.get('timeformat'), 'unixtime');
    return { ok: true, status: 200, json: () => ({ current: { time: 1800000000, ...readings } }) };
  });
  assert.deepEqual(response, { observed_at: new Date(1800000000000).toISOString(), readings });
});

test('falhas e valores ausentes permanecem distintos de condições válidas', async () => {
  assert.deepEqual(await getOpenMeteoCurrent(52.52, 13.41, async () => {
    throw new Error('offline fixture');
  }), { failure: 'UPSTREAM_UNAVAILABLE' });
  assert.deepEqual(await getOpenMeteoCurrent(52.52, 13.41, async () => ({
    ok: true, status: 200, json: () => ({ current: { time: 1800000000, precipitation: 0 } }),
  })), { failure: 'UPSTREAM_INVALID' });
  assert.deepEqual(await getOpenMeteoCurrent(91, 13.41, async () => {
    assert.fail('Coordenada inválida iniciou consulta.');
  }), { failure: 'UPSTREAM_INVALID' });
});
