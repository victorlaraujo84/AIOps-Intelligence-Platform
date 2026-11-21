import { createHmac } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { postOutboundHttpsJson, validateOutboundHttpsUrl } from '../../src/server/outbound-http.ts';

export type WebhookJob = {
  delivery_id: string;
  tenant_id: string;
  channel_id: string;
  origin: string;
  lease: string;
  event_id: string;
  incident_id: string;
  event_type: string;
  incident_status: string;
  severity: string;
  occurred_at_utc: Date;
};

type Outcome = {
  result: 'DELIVERED' | 'RATE_LIMIT' | 'REMOTE_ERROR' | 'HTTP_REJECTED' | 'TRANSPORT_ERROR' | 'NOT_CONFIGURED';
  status?: number;
  retryAfter?: number;
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

async function privateConfig(directory: string, job: WebhookJob, origins: ReadonlySet<string>) {
  if (!uuid.test(job.channel_id) || !origins.has(job.origin)) return;
  try {
    const handle = await open(join(directory, job.channel_id + '.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8192 || (stat.mode & 0o077) !== 0) return;
      const config = JSON.parse(await handle.readFile('utf8'));
      if (!config || config.tenantId !== job.tenant_id || typeof config.url !== 'string'
        || typeof config.signingKey !== 'string' || !/^[a-f0-9]{64}$/i.test(config.signingKey)) return;
      const { parsedUrl, ok } = validateOutboundHttpsUrl(config.url);
      if (!ok || !parsedUrl || parsedUrl.origin !== job.origin || parsedUrl.hash) return;
      return { url: parsedUrl.href, key: Buffer.from(config.signingKey, 'hex') };
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export function webhookDispatcher(
  directory: string, origins: ReadonlySet<string>, post = postOutboundHttpsJson,
) {
  return async (job: WebhookJob): Promise<Outcome> => {
    const target = await privateConfig(directory, job, origins);
    if (!target) return { result: 'NOT_CONFIGURED' };
    const envelope = {
      schema_version: '1.0',
      event_id: job.event_id,
      event_type: job.event_type,
      occurred_at_utc: job.occurred_at_utc.toISOString(),
      incident_id: job.incident_id,
      severity: job.severity,
      status: job.incident_status,
      correlation_id: job.event_id,
    };
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', target.key).update(timestamp + '.' + JSON.stringify(envelope)).digest('hex');
    try {
      const response = await post(target.url, envelope, {
        headers: {
          'X-AIOps-Timestamp': timestamp,
          'X-AIOps-Signature': 'v1=' + signature,
          'Idempotency-Key': job.delivery_id,
        },
        timeoutMs: 5000,
        statusOnly: true,
      });
      if (response.ok) return { result: 'DELIVERED', status: response.status };
      if (response.status === 429) return { result: 'RATE_LIMIT', status: 429, retryAfter: response.retryAfterSeconds };
      if (response.status >= 500 || response.status === 408) return { result: 'REMOTE_ERROR', status: response.status };
      return { result: 'HTTP_REJECTED', status: response.status };
    } catch {
      return { result: 'TRANSPORT_ERROR' };
    }
  };
}
