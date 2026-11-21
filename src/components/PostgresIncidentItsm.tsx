import { useEffect, useState } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { Message } from './PostgresInventoryFields.tsx';

type Ticket = {
  integration_id: string;
  name: string;
  provider: string;
  can_create: boolean;
  state: keyof typeof status | null;
  external_id: string | null;
  external_reference: string | null;
  last_error: string | null;
};

const status = {
  PENDING: 'Aguardando envio',
  PROCESSING: 'Processando',
  RETRY_SCHEDULED: 'Nova tentativa agendada',
  SUCCEEDED: 'Chamado confirmado',
  FAILED: 'Falha',
  NEEDS_RECONCILIATION: 'Conferência manual necessária',
};
const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';

export function PostgresIncidentItsm({ incidentId, tenant, mayRequest }: {
  incidentId: string; tenant: string; mayRequest: boolean;
}) {
  const path = '/inventory/incidents/' + incidentId + '/itsm/tickets';
  const [items, setItems] = useState<Ticket[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function refresh(signal?: AbortSignal) {
    const result = await request<{ items: Ticket[] }>(path, { headers: { 'X-AIOps-Expected-Tenant': tenant }, signal });
    setItems(result.items);
  }

  async function update(integrationId?: string) {
    setError('');
    setPending(true);
    try {
      if (integrationId) {
        await request(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
          body: JSON.stringify({ integration_id: integrationId }),
        });
      }
      await refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, [path, tenant]);

  return (
    <section className="space-y-3 rounded-md border border-slate-800 p-4">
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">Chamados ITSM</h4>
        <button type="button" className={button} disabled={pending} onClick={() => void update()}>Atualizar</button>
      </div>
      {error && <Message>{error}</Message>}
      {items?.length === 0 && <p className="text-sm">Nenhum destino habilitado neste tenant.</p>}
      {items && items.length > 0 && <ul className="space-y-3">
        {items.map(item => (
          <li key={item.integration_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{item.name}{item.state ? ' · ' + status[item.state] : ''}
              {(item.external_reference ?? item.external_id) && ' · ' + (item.external_reference ?? item.external_id)}
              {item.last_error && ' · ' + item.last_error}
            </span>
            {mayRequest && item.can_create && !item.state &&
              <button type="button" className={button} disabled={pending} onClick={() => void update(item.integration_id)}>
                Solicitar chamado
              </button>}
          </li>
        ))}
      </ul>}
    </section>
  );
}
