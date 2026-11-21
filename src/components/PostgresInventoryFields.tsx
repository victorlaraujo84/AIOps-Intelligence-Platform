import { useId, useState } from 'react';
import { request } from '../lib/postgres-console.ts';

export type Choice = { id: string; code: string; name?: string; label?: string };
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

export function CatalogField({ name, label, choices, initial, disabled }: {
  name: string;
  label: string;
  choices: Choice[];
  initial: string;
  disabled: boolean;
}) {
  const id = useId();
  const [selected, setSelected] = useState(initial);
  return (
    <div className="space-y-1 text-sm">
      <label htmlFor={id}>{label}</label>
      <select id={id} className={field} name={name} value={selected} onChange={event => setSelected(event.target.value)} disabled={disabled}>
        <option value="">Sem vínculo</option>
        {initial && !choices.some(choice => choice.id === initial) && <option value={initial}>Vínculo atual</option>}
        {choices.map(choice => (
          <option key={choice.id} value={choice.id}>{choice.code} · {choice.name ?? choice.label}</option>
        ))}
      </select>
    </div>
  );
}
