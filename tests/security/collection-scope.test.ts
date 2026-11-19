import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { matchIpv4Cidr, matchTargetPattern } from '../../src/server/collection.ts';
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

test('matchIpv4Cidr e matchTargetPattern validam CIDR e bloqueiam curinga irrestrito', () => {
  assert.equal(matchIpv4Cidr('10.20.1.45', '10.20.1.0/24'), true);
  assert.equal(matchIpv4Cidr('10.20.2.45', '10.20.1.0/24'), false);
  assert.equal(matchTargetPattern('api-core.interno.local', '*.interno.local'), true);
  assert.equal(matchTargetPattern('externo.com', '*.interno.local'), false);
});

test('bloqueia coleta nativa/OTLP fora de escopo autorizado e audita tentativa', async () => {
  const { server, db, baseUrl } = await startServer();
  try {
    const boot = await req(baseUrl, '/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        email: 'sec@test.local',
        full_name: 'Sec Admin',
        password: 'SecPassword123',
        initial_tenant_name: 'Tenant A',
      }),
    });
    const token = boot.body.token as string;

    // Proíbe wildcard genérico "*"
    const wildcardAttempt = await req(baseUrl, '/api/collection/scopes', {
      method: 'POST',
      token,
      body: JSON.stringify({ protocol: 'icmp', target_cidr_or_host: '*' }),
    });
    assert.equal(wildcardAttempt.status, 400);

    // Tentativa de coleta sem escopo aprovado -> 403 + trilha de auditoria
    const blocked = await req(baseUrl, '/api/collection/native/ingest', {
      method: 'POST',
      token,
      body: JSON.stringify({
        protocol: 'icmp',
        target: '10.50.0.10',
        metrics: [
          {
            idempotency_key: 'icmp-1',
            metric_name: 'rtt_ms',
            value_num: 12.4,
            unit: 'ms',
            observed_at_utc: '2026-11-19T12:00:00Z',
            source: 'icmp',
          },
        ],
      }),
    });
    assert.equal(blocked.status, 403);

    const logsRes = await req(baseUrl, '/api/audit-logs', { token });
    const logs = logsRes.body.logs as Array<{ action: string }>;
    assert.ok(logs.some((l) => l.action === 'UNAUTHORIZED_COLLECTION_TARGET'));

    // Aprova escopo específico 10.50.0.0/24 e valida ingestão autorizada
    const scopeRes = await req(baseUrl, '/api/collection/scopes', {
      method: 'POST',
      token,
      body: JSON.stringify({ protocol: 'icmp', target_cidr_or_host: '10.50.0.0/24', description: 'Rede Core' }),
    });
    assert.equal(scopeRes.status, 201);

    const allowed = await req(baseUrl, '/api/collection/native/ingest', {
      method: 'POST',
      token,
      body: JSON.stringify({
        protocol: 'icmp',
        target: '10.50.0.10',
        metrics: [
          {
            idempotency_key: 'icmp-allowed-1',
            metric_name: 'rtt_ms',
            value_num: 12.4,
            unit: 'ms',
            observed_at_utc: '2026-11-19T12:00:00Z',
            source: 'icmp',
          },
        ],
      }),
    });
    assert.equal(allowed.status, 201);
  } finally {
    server.close();
    db.close();
  }
});
