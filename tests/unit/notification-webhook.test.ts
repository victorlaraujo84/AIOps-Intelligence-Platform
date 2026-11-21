import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { webhookDispatcher, type WebhookJob } from '../../services/notification-worker/webhook.ts';

const job: WebhookJob = {
  delivery_id: '00000000-0000-4000-9000-000000000001',
  tenant_id: '00000000-0000-4000-9000-000000000002',
  channel_id: '00000000-0000-4000-9000-000000000003',
  lease: '00000000-0000-4000-9000-000000000004',
  event_id: '00000000-0000-4000-9000-000000000005',
  incident_id: '00000000-0000-4000-9000-000000000006',
  event_type: 'incident.opened',
  incident_status: 'OPEN',
  severity: 'CRITICA',
  origin: 'https://webhook.example.invalid',
  occurred_at_utc: new Date('2026-11-21T12:00:00Z'),
};
const fakeKey = '34'.repeat(32);
const config = { tenantId: job.tenant_id, url: job.origin + '/events', signingKey: fakeKey };
const response = (status: number) => ({ status, ok: status >= 200 && status < 300, json: () => null });

test('assina os mesmos bytes e preserva a idempotência em uma retentativa', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-webhook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, job.channel_id + '.json'), JSON.stringify(config), { mode: 0o600 });
  let calls = 0;
  const dispatch = webhookDispatcher(dir, new Set([job.origin]), async (url, envelope, options) => {
    calls++;
    assert.equal(url, config.url);
    const headers = options?.headers ?? {};
    const bytes = headers['X-AIOps-Timestamp'] + '.' + JSON.stringify(envelope);
    assert.equal(headers['X-AIOps-Signature'], 'v1=' + createHmac('sha256', Buffer.from(fakeKey, 'hex')).update(bytes).digest('hex'));
    assert.equal(headers['Idempotency-Key'], job.delivery_id);
    assert.deepEqual(envelope, {
      schema_version: '1.0', event_id: job.event_id, event_type: job.event_type, occurred_at_utc: job.occurred_at_utc.toISOString(),
      incident_id: job.incident_id, severity: 'CRITICA', status: 'OPEN', correlation_id: job.event_id,
    });
    return calls === 1 ? { ...response(429), retryAfterSeconds: 240 } : response(204);
  });
  assert.deepEqual(await dispatch(job), { result: 'RATE_LIMIT', status: 429, retryAfter: 240 });
  assert.deepEqual(await dispatch(job), { result: 'DELIVERED', status: 204 });
});

test('exige arquivo privado, tenant correspondente e origem aprovada', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'aiops-webhook-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, job.channel_id + '.json');
  const dispatch = webhookDispatcher(dir, new Set([job.origin]), async () => assert.fail('Envio inesperado'));
  for (const invalid of [
    { ...config, tenantId: 'different-tenant' },
    { ...config, url: 'https://unrelated.example.invalid' },
    { ...config, signingKey: 'invalid' },
  ]) {
    await writeFile(file, JSON.stringify(invalid), { mode: 0o600 });
    assert.deepEqual(await dispatch(job), { result: 'NOT_CONFIGURED' });
  }
  await writeFile(file, JSON.stringify(config));
  assert.deepEqual(await dispatch({ ...job, origin: 'https://unrelated.example.invalid' }), { result: 'NOT_CONFIGURED' });
});
