import { useEffect, useId, useState, type ReactNode } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';

export type Choice = { id: string; code?: string; name?: string; label?: string };
type Catalog = { items: Choice[]; next_after: string | null };
export const field = 'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100';
export const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';

export async function loadCatalog(resource: string, signal: AbortSignal): Promise<Choice[]> {
  const items: Choice[] = [];
  let after: string | null = null;
  do {
    const query = new URLSearchParams({ limit: '200' });
    if (after) query.set('after', after);
    const page: Catalog = await request('/inventory/' + resource + '?' + query, { signal });
    items.push(...page.items);
    after = page.next_after;
  } while (after);
  return items;
}

export function CatalogField({ name, label, choices, initial, disabled, required = false }: {
  name: string;
  label: string;
  choices: Choice[];
  initial: string;
  disabled: boolean;
  required?: boolean;
}) {
  const id = useId();
  const [selected, setSelected] = useState(initial);
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id}>{label}</label>
      <select id={id} className={field} name={name} value={selected} onChange={event => setSelected(event.target.value)} disabled={disabled} required={required}>
        <option value="" disabled={required}>{required ? 'Selecione uma opção' : 'Sem vínculo'}</option>
        {initial && !choices.some(choice => choice.id === initial) && <option value={initial}>Vínculo atual</option>}
        {choices.map(choice => (
          <option key={choice.id} value={choice.id}>{choice.code && choice.code + ' · '}{choice.name ?? choice.label}</option>
        ))}
      </select>
    </div>
  );
}

export function Message({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-md border border-rose-800 px-3 py-2 text-sm text-rose-200">{children}</p>;
}

type Page<T> = { items: T[]; next_after: string | null };

export function PagedData<T extends { id: string }>({ endpoint, render }: { endpoint: string; render: (rows: T[]) => ReactNode }) {
  const [rows, setRows] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load(after?: string, signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const url = new URL(endpoint, window.location.origin);
      if (after) url.searchParams.set('after', after);
      const page = await request<Page<T>>(url.pathname + url.search, { signal });
      setRows(previous => after ? [...previous, ...page.items] : page.items);
      setNext(page.next_after);
    } catch (error) {
      if (!signal?.aborted) setError(errorMessage(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [endpoint]);

  return (
    <div className="space-y-3">
      {rows.length > 0 && render(rows)}
      {loading && <p role="status" className="text-sm text-slate-400">Carregando…</p>}
      {!loading && !error && rows.length === 0 && <p className="text-sm text-slate-400">Nenhum registro disponível.</p>}
      {error && <Message>{error}</Message>}
      {next && <button className={button} disabled={loading} onClick={() => void load(next)}>Mais resultados</button>}
    </div>
  );
}
