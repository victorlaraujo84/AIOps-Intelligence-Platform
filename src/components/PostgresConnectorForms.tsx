import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { Message, PagedData } from './PostgresInventoryFields.tsx';

const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';
const input = 'w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-slate-100';
type BatchResult = { ingested: number; deduplicated: number; created_incidents?: number };

const signalLabels = { events: 'eventos', metrics: 'métricas', logs: 'logs' };
type Signal = keyof typeof signalLabels;

function send<T>(path: string, tenant: string, body: object) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
    body: JSON.stringify(body),
  });
}

export function PostgresConnectorCreate({ tenant, onCreated }: { tenant: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !name.trim()) return;
    setPending(true);
    setError('');
    try {
      await send('/inventory/connectors', tenant, { name });
      setName('');
      onCreated();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-2 rounded-md border border-slate-800 p-4" onSubmit={create}>
      <label className="block text-sm">
        Nome do conector para importação
        <input value={name} onChange={event => setName(event.target.value)} required maxLength={120} className={input} />
      </label>
      {error && <Message>{error}</Message>}
      <button type="submit" className={button} disabled={!name.trim() || pending}>Cadastrar conector</button>
    </form>
  );
}

export function PostgresConnectorImport({ tenant, connector, name, onImported, onClose }: {
  tenant: string; connector: string; name: string; onImported: (summary: BatchResult) => void; onClose: () => void;
}) {
  const [signal, setSignal] = useState<Signal>('events');
  const [file, setFile] = useState<File>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function ingest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || pending) return;
    setError('');
    setPending(true);
    try {
      let payload: unknown;
      try {
        if (file.size > 512 * 1024) throw new Error();
        payload = JSON.parse(await file.text());
      } catch {
        setError('Envie um arquivo JSON válido de até 512 KiB.');
        return;
      }
      const records: unknown = Array.isArray(payload) ? payload :
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>)[signal] : undefined;
      if (!Array.isArray(records) || records.length < 1 || records.length > 100) {
        setError(`Inclua entre 1 e 100 registros de ${signalLabels[signal]} no arquivo.`);
        return;
      }
      const suffix = signal === 'events' ? '' : '/' + signal;
      const result = await send<BatchResult>('/inventory/connectors/' + connector + '/ingest' + suffix, tenant, { [signal]: records });
      onImported(result);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-3 rounded-md border border-slate-800 p-4" onSubmit={ingest}>
      <h3 className="font-semibold">Importar telemetria em {name}</h3>
      <label className="block text-sm">
        Tipo de telemetria
        <select value={signal} disabled={pending} className={input}
          onChange={event => { setSignal(event.target.value as Signal); setFile(undefined); setError(''); }}>
          {Object.entries(signalLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label className="block text-sm">
        Arquivo JSON com {signalLabels[signal]}
        <input key={signal} type="file" accept=".json,application/json" className={input} required
          onChange={event => setFile(event.target.files?.[0])} />
      </label>
      {error && <Message>{error}</Message>}
      <div className="flex gap-2">
        <button type="submit" className={button} disabled={pending || !file}>Importar</button>
        <button type="button" className={button} disabled={pending} onClick={onClose}>Cancelar</button>
      </div>
    </form>
  );
}


type WeatherSite = { id: string; code: string; name: string; coord_verified: boolean };

export function PostgresOpenMeteoCreate({ tenant, onCreated }: { tenant: string; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [site, setSite] = useState('');
  const [permission, setPermission] = useState(false);
  const [nonCommercial, setNonCommercial] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const ready = name.trim() && site && permission && nonCommercial;

  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    setError('');
    setPending(true);
    try {
      await send('/inventory/connectors/open-meteo', tenant, {
        name, site_id: site, public_coordinates_authorized: permission, non_commercial_use_confirmed: nonCommercial,
      });
      setName('');
      setSite('');
      setPermission(false);
      setNonCommercial(false);
      onCreated();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <details className="rounded-md border border-slate-800 p-4">
      <summary className="cursor-pointer font-semibold">Configurar Open-Meteo</summary>
      <form className="mt-3 space-y-3 text-sm" onSubmit={configure}>
        <label className="block">Nome do conector
          <input className={input} required maxLength={120} value={name} onChange={event => setName(event.target.value)} />
        </label>
        <PagedData<WeatherSite> endpoint="/inventory/sites" expectedTenant={tenant} render={rows => (
          <label className="block">Site com coordenadas verificadas
            <select className={input} required value={site} onChange={event => setSite(event.target.value)}>
              <option value="">Selecione um site</option>
              {rows.filter(row => row.coord_verified).map(row => (
                <option key={row.id} value={row.id}>{row.code} — {row.name}</option>
              ))}
            </select>
          </label>
        )} />
        <label className="flex gap-2">
          <input type="checkbox" checked={permission} onChange={event => setPermission(event.target.checked)} />
          Autorizo o envio das coordenadas atuais deste site ao Open-Meteo.
        </label>
        <label className="flex gap-2">
          <input type="checkbox" checked={nonCommercial} onChange={event => setNonCommercial(event.target.checked)} />
          Confirmo o uso não comercial da API pública.
        </label>
        {error && <Message>{error}</Message>}
        <button type="submit" className={button} disabled={!ready || pending}>Salvar Open-Meteo</button>
      </form>
    </details>
  );
}

export function PostgresOpenMeteoActions({ tenant, connector, mayDisable, onChanged }: {
  tenant: string; connector: string; mayDisable: boolean; onChanged: (message: string) => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function act(action: 'sync' | 'disable') {
    if (pending) return;
    setError('');
    setPending(true);
    try {
      const result = await send<{ status?: string; ingested?: number; deduplicated?: number }>(
        '/inventory/connectors/' + connector + '/open-meteo/' + action, tenant, {},
      );
      if (action === 'disable') {
        onChanged('Coleta climática desativada.');
      } else if (result.status === 'SUCCESS') {
        onChanged(`${result.ingested} métricas climáticas ingeridas e ${result.deduplicated} duplicadas.`);
      } else {
        setError('Falha ao sincronizar. A tentativa foi registrada.');
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="space-y-2 rounded-md border border-slate-800 p-4">
      <h3 className="font-semibold">Condições climáticas atuais</h3>
      <p className="text-sm text-slate-300">Dados modelados por <a className="underline" href="https://open-meteo.com/">Open-Meteo</a>.</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={pending} onClick={() => void act('sync')}>
          {pending ? 'Processando…' : 'Sincronizar clima'}
        </button>
        {mayDisable && <button type="button" className={button} disabled={pending} onClick={() => void act('disable')}>
          Desativar coleta climática
        </button>}
      </div>
      {error && <Message>{error}</Message>}
      {mayDisable && <PostgresOpenMeteoSchedule tenant={tenant} connector={connector} />}
    </section>
  );
}


type WeatherSchedule = { interval_minutes: number | null; next_run_at_utc: string | null; scope_valid: boolean };

function PostgresOpenMeteoSchedule({ tenant, connector }: { tenant: string; connector: string }) {
  const [schedule, setSchedule] = useState<WeatherSchedule>();
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const path = '/inventory/connectors/' + connector + '/open-meteo/schedule';

  async function load(signal?: AbortSignal) {
    const result = await request<WeatherSchedule>(path, { headers: { 'X-AIOps-Expected-Tenant': tenant }, signal });
    setSchedule(result);
    setSelected(result.interval_minutes === null ? '' : String(result.interval_minutes));
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    });
    return () => controller.abort();
  }, [path, tenant]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !schedule) return;
    setError('');
    setPending(true);
    try {
      await send(path, tenant, { interval_minutes: selected ? Number(selected) : null });
      await load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-2 border-t border-slate-800 pt-3 text-sm" onSubmit={save}>
      {error && <Message>{error}</Message>}
      {schedule && (
        <>
          <label className="block">Frequência da coleta automática
            <select className={input} value={selected} onChange={event => setSelected(event.target.value)} disabled={pending}>
              <option value="">Desativada</option>
              {[15, 30, 60, 180].map(minutes => (
                <option value={minutes} key={minutes} disabled={!schedule.scope_valid}>A cada {minutes} minutos</option>
              ))}
            </select>
          </label>
          <p className="text-slate-300" role="status">{schedule.scope_valid
            ? (schedule.next_run_at_utc
              ? 'Coleta elegível a partir de ' + new Date(schedule.next_run_at_utc).toLocaleString('pt-BR') + '.'
              : 'Coleta automática desativada.')
            : 'Atualize a autorização das coordenadas para habilitar a coleta.'}</p>
          <button type="submit" className={button} disabled={pending || (selected !== '' && !schedule.scope_valid)}>
            Salvar agendamento
          </button>
        </>
      )}
    </form>
  );
}
