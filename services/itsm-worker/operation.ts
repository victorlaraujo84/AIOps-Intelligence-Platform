import { join } from 'node:path';
import { parseItsmDestination, readPrivateItsmFile } from '../../src/server/itsm-config.ts';
import { createItsmAdapter, type ItsmDestination } from '../../src/server/itsm-http.ts';

export type TicketOperation = {
  operation_id: string;
  tenant_id: string;
  incident_id: string;
  integration_id: string;
  provider: ItsmDestination['provider'];
  lease_token: string;
};

type Result = { code: string; externalId: string | null; reference: string | null; retryAfterSeconds?: number };
type Adapter = ReturnType<typeof createItsmAdapter>;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function ticketDispatcher(directory: string, adapterFor: (destination: ItsmDestination) => Adapter = createItsmAdapter) {
  return async (job: TicketOperation): Promise<Result> => {
    const unavailable = { code: 'NOT_CONFIGURED', externalId: null, reference: null };
    if (!uuid.test(job.integration_id) || !uuid.test(job.incident_id) || !uuid.test(job.tenant_id)) return unavailable;
    let adapter: Adapter;
    try {
      const file = await readPrivateItsmFile(join(directory, job.integration_id + '.json'));
      if (!file || typeof file !== 'object' || !('tenantId' in file) || file.tenantId !== job.tenant_id) return unavailable;
      const destination = parseItsmDestination(file, true);
      if (destination.provider !== job.provider) return unavailable;
      adapter = adapterFor(destination);
    } catch {
      return unavailable;
    }
    // Share only the tenant-approved incident reference. Notes and telemetry stay local.
    const result = await adapter.createTicket({
      summary: 'Incidente AIOps ' + job.incident_id,
      description: 'Incidente encaminhado pela AIOps Intelligence Platform. Referência local ' + job.incident_id + '.',
    });
    return result.ok
      ? { code: 'SUCCEEDED', externalId: result.value.externalId, reference: result.value.reference }
      : { code: result.code, externalId: null, reference: null, retryAfterSeconds: result.retryAfterSeconds };
  };
}
