import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { Message } from './PostgresInventoryFields.tsx';

const eventLabels = {
  'incident.opened': 'Abertura',
  'incident.acknowledged': 'Reconhecimento',
  'incident.resolved': 'Resolução',
  'incident.reopened': 'Reabertura',
};
type EventType = keyof typeof eventLabels;
type Channel = { id: string; name: string; origin: string; event_types: EventType[]; critical_only: boolean; enabled: boolean };
type Delivery = { id: string; event_type: EventType; state: string; attempt_count: number; outcome: string | null; http_status: number | null };
const path = '/inventory/webhooks';
const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';
const input = 'w-full rounded-md border border-slate-700 bg-slate-950 p-2';
const states: Record<string, string> = {
  PENDING: 'Pendente', PROCESSING: 'Em processamento', DELIVERED: 'Confirmada por HTTP',
  RETRY_SCHEDULED: 'Retentativa agendada', DEAD_LETTER: 'Falha final', DISABLED: 'Cancelada',
};

export function PostgresWebhooks({ tenant, mayWrite }: { tenant: string; mayWrite: boolean }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selected, setSelected] = useState('');
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [name, setName] = useState('');
  const [origin, setOrigin] = useState('');
  const [events, setEvents] = useState<EventType[]>(['incident.opened']);
  const [critical, setCritical] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedChannel = channels.find(channel => channel.id === selected);
  const headers = { 'X-AIOps-Expected-Tenant': tenant };

  async function loadChannels(signal?: AbortSignal) {
    const result = await request<{ items: Channel[] }>(path, { headers, signal });
    setChannels(result.items);
  }

  async function loadDeliveries(channel: string, signal?: AbortSignal) {
    const result = await request<{ items: Delivery[] }>(path + '/' + channel + '/deliveries', { headers, signal });
    setDeliveries(result.items);
  }

  useEffect(() => {
    const controller = new AbortController();
    void loadChannels(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, [tenant]);

  useEffect(() => {
    setDeliveries(null);
    if (!selected) return;
    const controller = new AbortController();
    void loadDeliveries(selected, controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, [tenant, selected]);

  async function run(action: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      const result = await request<{ id: string }>(path, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, origin, event_types: events, critical_only: critical }),
      });
      await loadChannels();
      setSelected(result.id);
      setName('');
      setOrigin('');
    });
  }

  function toggle(channel: Channel) {
    void run(async () => {
      await request(path + '/' + channel.id + '/status', {
        method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !channel.enabled }),
      });
      await loadChannels();
      if (selected === channel.id) await loadDeliveries(channel.id);
    });
  }

  return (
    <div className="space-y-4">
      {error && <Message>{error}</Message>}
      {mayWrite && (
        <form className="space-y-3 rounded-md border border-slate-800 p-4 text-sm" onSubmit={create}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label>Nome do canal<input className={input} value={name} required maxLength={120}
              onChange={event => setName(event.target.value)} /></label>
            <label>Origem HTTPS<input className={input} type="url" value={origin} required maxLength={255}
              onChange={event => setOrigin(event.target.value)} placeholder="https://eventos.exemplo.com" /></label>
          </div>
          <fieldset className="flex flex-wrap gap-3">
            <legend>Eventos enviados</legend>
            {Object.entries(eventLabels).map(([key, label]) => {
              const eventType = key as EventType;
              return <label className="flex items-center gap-2" key={key}>
                <input type="checkbox" checked={events.includes(eventType)} onChange={event => {
                  setEvents(event.target.checked ? [...events, eventType] : events.filter(item => item !== eventType));
                }} />{label}
              </label>;
            })}
          </fieldset>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={critical} onChange={event => setCritical(event.target.checked)} />
            Somente incidentes críticos
          </label>
          <button type="submit" className={button} disabled={busy || events.length === 0}>Cadastrar webhook</button>
        </form>
      )}
      {channels.length === 0 && <p className="text-sm text-slate-300">Nenhum canal cadastrado neste tenant.</p>}
      {channels.map(channel => (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 p-3 text-sm" key={channel.id}>
          <div>
            <p className="font-semibold">{channel.name} · {channel.enabled ? 'Ativo' : 'Desativado'}</p>
            <p className="break-all text-slate-300">{channel.origin}</p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => setSelected(channel.id)}>Ver entregas</button>
            {mayWrite && <button type="button" className={button} disabled={busy} onClick={() => toggle(channel)}>
              {channel.enabled ? 'Desativar' : 'Ativar'}
            </button>}
          </div>
        </div>
      ))}
      {selectedChannel && (
        <section className="space-y-3 rounded-md border border-slate-800 p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold">Entregas de {selectedChannel.name}</h3>
            <button className={button} type="button" disabled={busy} onClick={() => void run(() => loadDeliveries(selected))}>Atualizar</button>
          </div>
          <p className="break-all text-slate-300">ID do canal para configuração do worker {selectedChannel.id}</p>
          {deliveries?.length === 0 && <p>Nenhuma entrega registrada.</p>}
          {deliveries && deliveries.length > 0 && (
            <ul className="space-y-2">
              {deliveries.map(item => (
                <li key={item.id}>{eventLabels[item.event_type]} · {states[item.state]} · {item.attempt_count} tentativa(s)
                  {item.http_status && ' · HTTP ' + item.http_status}
                  {item.outcome && item.outcome !== 'DELIVERED' && ' · ' + item.outcome}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
