import { useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { Message } from './PostgresInventoryFields.tsx';

const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';
const input = 'w-full rounded-md border border-slate-700 bg-slate-950 p-2 text-slate-100';
type BatchResult = { ingested: number; deduplicated: number; created_incidents: number };

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
      const events: unknown = Array.isArray(payload) ? payload : (
        payload && typeof payload === 'object' && 'events' in payload ? payload.events : undefined
      );
      if (!Array.isArray(events) || events.length < 1 || events.length > 100) {
        setError('Inclua entre 1 e 100 eventos canônicos no arquivo.');
        return;
      }
      const result = await send<BatchResult>('/inventory/connectors/' + connector + '/ingest', tenant, { events });
      onImported(result);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-3 rounded-md border border-slate-800 p-4" onSubmit={ingest}>
      <h3 className="font-semibold">Importar eventos em {name}</h3>
      <label className="block text-sm">
        Arquivo JSON com eventos canônicos
        <input type="file" accept=".json,application/json" className={input} required
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
