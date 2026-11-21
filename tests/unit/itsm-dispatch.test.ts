import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ticketDispatcher, type TicketOperation } from '../../services/itsm-worker/operation.ts';

const operation: TicketOperation = {
  provider: 'servicenow',
  integration_id: '00000000-0000-4000-9000-000000000001',
  tenant_id: '00000000-0000-4000-9000-000000000002',
  incident_id: '00000000-0000-4000-9000-000000000003',
  operation_id: '00000000-0000-4000-9000-000000000004',
  lease_token: '00000000-0000-4000-9000-000000000005',
};

test('worker encaminha o mínimo e respeita o vínculo entre a credencial e o tenant', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'aiops-itsm-fixture-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  let dispatched = 0;
  const config = {
    provider: 'servicenow', tenantId: operation.tenant_id,
    baseUrl: 'https://itsm.example.invalid', allowedOrigin: 'https://itsm.example.invalid',
    auth: { method: 'bearer', accessToken: 'fixture-only' },
  };
  const dispatch = ticketDispatcher(directory, destination => ({
    getTicket: async () => assert.fail('Consulta não esperada'),
    createTicket: async input => {
      dispatched++;
      assert.ok(destination.capabilities.create_ticket);
      assert.ok(input.summary.includes(operation.incident_id));
      assert.ok(!input.description.includes(operation.tenant_id));
      return { ok: true, value: { externalId: 'fixture-id', reference: 'INC0001' } };
    },
  }));
  assert.equal((await dispatch(operation)).code, 'NOT_CONFIGURED');
  await writeFile(join(directory, operation.integration_id + '.json'), JSON.stringify(config), { mode: 0o600 });
  assert.equal((await dispatch({ ...operation, tenant_id: operation.operation_id })).code, 'NOT_CONFIGURED');
  assert.equal((await dispatch({ ...operation, provider: 'topdesk' })).code, 'NOT_CONFIGURED');
  assert.deepEqual(await dispatch(operation), { code: 'SUCCEEDED', externalId: 'fixture-id', reference: 'INC0001' });
  assert.equal(dispatched, 1);
});
