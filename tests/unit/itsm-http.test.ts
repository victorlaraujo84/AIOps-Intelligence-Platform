import assert from 'node:assert/strict';
import test from 'node:test';
import { createItsmAdapter } from '../../src/server/itsm-http.ts';

type Destination = Parameters<typeof createItsmAdapter>[0];
type Transport = NonNullable<Parameters<typeof createItsmAdapter>[1]>;
const base = {
  baseUrl: 'https://itsm.example.invalid',
  allowedOrigin: 'https://itsm.example.invalid',
  capabilities: { create_ticket: true, get_ticket: true },
};
const basic = { method: 'basic', username: 'integration-fixture', apiPassword: 'fixture-only' } as const;
const input = { summary: 'Falha de teste', description: 'Evento de homologação' };
const callerId = '00000000-0000-4000-9000-000000000077';

const cases = [
  {
    destination: { ...base, provider: 'glpi', auth: { method: 'glpi_session', userToken: 'fixture-user', appToken: 'fixture-app' } },
    path: '/apirest.php/Ticket', id: '18', remote: { id: 18 },
    payload: { input: { name: input.summary, content: input.description } },
  },
  {
    destination: { ...base, provider: 'servicenow', auth: { method: 'bearer', accessToken: 'fixture-access' } },
    path: '/api/now/v1/table/incident', id: '108752c8c611227601d4ab0e39297f',
    remote: { result: { sys_id: '108752c8c611227601d4ab0e39297f', number: 'INC0001234' } },
    payload: { short_description: input.summary, description: input.description },
  },
  {
    destination: { ...base, provider: 'jira-service-management', auth: basic,
      serviceDeskId: '3', requestTypeId: '17', requiredFields: { customfield_10042: 'teste' } },
    path: '/rest/servicedeskapi/request', id: 'AIOPS-2', remote: { issueId: '10002', issueKey: 'AIOPS-2' },
    payload: { serviceDeskId: '3', requestTypeId: '17', requestFieldValues: { customfield_10042: 'teste', ...input } },
  },
  {
    destination: { ...base, provider: 'topdesk', auth: basic, callerId },
    path: '/tas/api/incidents', id: callerId, remote: { id: callerId, number: 'I 2601 001' },
    payload: { briefDescription: input.summary, request: input.description, caller: { id: callerId } },
  },
] satisfies { destination: Destination; path: string; id: string; remote: object; payload: object }[];

for (const fixture of cases) {
  test(`monta criação e consulta documentadas para ${fixture.destination.provider}`, async () => {
    const methods: string[] = [];
    const transport: Transport = {
      async get(url, options) {
        const path = new URL(url).pathname;
        methods.push('GET ' + path);
        if (path.endsWith('/initSession')) {
          assert.equal(options?.headers?.Authorization, 'user_token fixture-user');
          return { ok: true, status: 200, json: () => ({ session_token: 'fixture-session' }) };
        }
        if (fixture.destination.provider === 'glpi') {
          assert.equal(options?.headers?.['Session-Token'], 'fixture-session');
          assert.equal(options?.headers?.['App-Token'], 'fixture-app');
        }
        return { ok: true, status: 200, json: () => fixture.remote };
      },
      async post(url, body, options) {
        assert.equal(new URL(url).origin, base.allowedOrigin);
        assert.deepEqual(body, fixture.payload);
        if (fixture.destination.provider === 'glpi') assert.equal(options?.headers?.['Session-Token'], 'fixture-session');
        else assert.ok(options?.headers?.Authorization);
        methods.push('POST ' + new URL(url).pathname);
        return { ok: true, status: 201, json: () => fixture.remote };
      },
    };
    const adapter = createItsmAdapter(fixture.destination, transport);
    const created = await adapter.createTicket(input);
    assert.ok(created.ok);
    assert.equal(created.value.externalId, fixture.id);
    assert.deepEqual(await adapter.getTicket(fixture.id), created);
    const getPath = fixture.path + (fixture.destination.provider === 'topdesk' ? '/id/' : '/') + fixture.id;
    if (fixture.destination.provider === 'glpi') {
      assert.deepEqual(methods, [
        'GET /apirest.php/initSession', 'POST ' + fixture.path, 'GET /apirest.php/killSession',
        'GET /apirest.php/initSession', 'GET ' + getPath, 'GET /apirest.php/killSession',
      ]);
    } else {
      assert.deepEqual(methods, ['POST ' + fixture.path, 'GET ' + getPath]);
    }
  });
}

test('bloqueia destino diferente da origem autorizada e opera somente com capacidades habilitadas', async () => {
  const transport: Transport = {
    get: async () => assert.fail('GET inesperado'),
    post: async () => assert.fail('POST inesperado'),
  };
  assert.throws(() => createItsmAdapter({ ...cases[1].destination, baseUrl: 'https://elsewhere.example.invalid' }, transport), /Origem HTTPS/);
  assert.throws(() => createItsmAdapter({ ...cases[1].destination, baseUrl: 'https://127.0.0.1', allowedOrigin: 'https://127.0.0.1' }, transport), /Origem HTTPS/);
  const inactive = createItsmAdapter({
    ...cases[1].destination, capabilities: { create_ticket: false, get_ticket: false },
  }, transport);
  assert.deepEqual(await inactive.createTicket(input), { ok: false, code: 'NOT_SUPPORTED', retryable: false });
  const active = createItsmAdapter(cases[1].destination, transport);
  assert.deepEqual(await active.getTicket('../incident'), { ok: false, code: 'VALIDATION', retryable: false });
});

test('resultado incerto de criação exige reconciliação', async () => {
  let posts = 0;
  const destination = cases[1].destination;
  const transport: Transport = {
    get: async () => assert.fail('GET inesperado'),
    post: async () => {
      posts++;
      if (posts === 1) throw new Error('Timeout');
      if (posts === 2) return { ok: true, status: 201, json: () => ({ result: {} }) };
      if (posts === 3) return { ok: false, status: 503, json: () => undefined };
      return { ok: false, status: 429, json: () => undefined };
    },
  };
  const adapter = createItsmAdapter(destination, transport);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.deepEqual(await adapter.createTicket(input), { ok: false, code: 'NEEDS_RECONCILIATION', retryable: false });
    assert.equal(posts, attempt);
  }
  assert.deepEqual(await adapter.createTicket(input), { ok: false, code: 'RATE_LIMIT', retryable: true });
});
