import { useEffect, useId, useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';

type Site = { id: string } & Record<string, string | number | null>;
type Choice = { id: string; code: string; name?: string; label?: string };
type Catalog = { items: Choice[]; next_after: string | null };
const field = 'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100';
const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';

async function loadCatalog(resource: string, signal: AbortSignal): Promise<Choice[]> {
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

function CatalogField({ name, label, choices, initial, disabled }: {
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

export function PostgresSiteEditor({ tenant, site, onCancel, onSaved }: {
  tenant: string;
  site?: Site;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [catalogs, setCatalogs] = useState<{ concessions: Choice[]; localityTypes: Choice[] }>();
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadCatalog('concessions', controller.signal),
      loadCatalog('locality-types', controller.signal),
    ]).then(([concessions, localityTypes]) => setCatalogs({ concessions, localityTypes }))
      .catch(error => { if (!controller.signal.aborted) setCatalogError(errorMessage(error)); });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload: Record<string, string | null> = {};
    for (const [name, raw] of data.entries()) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim() || null;
      if (!site || value !== (site[name] ?? null)) payload[name] = value;
    }
    if (Object.keys(payload).length === 0) {
      setError('Altere pelo menos um campo para salvar.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const path = site ? '/inventory/sites/' + site.id : '/inventory/sites';
      await request(path, {
        method: site ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={save}>
      <h3 className="font-semibold">{site ? 'Editar site' : 'Novo site'}</h3>
      <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2">
        {!site && <label className="space-y-1 text-sm"><span>Código</span>
          <input className={field} name="code" maxLength={64} required />
        </label>}
        <label className="space-y-1 text-sm"><span>Nome</span>
          <input className={field} name="name" maxLength={200} defaultValue={site?.name ?? ''} required />
        </label>
        <label className="space-y-1 text-sm"><span>Endereço</span>
          <input className={field} name="address" maxLength={400} defaultValue={site?.address ?? ''} />
        </label>
        <label className="space-y-1 text-sm"><span>CEP</span>
          <input className={field} name="cep" inputMode="numeric" pattern="[0-9]{5}-?[0-9]{3}" maxLength={9} defaultValue={site?.cep ?? ''} />
        </label>
        <label className="space-y-1 text-sm"><span>Município</span>
          <input className={field} name="municipality" maxLength={200} defaultValue={site?.municipality ?? ''} />
        </label>
        <label className="space-y-1 text-sm"><span>UF</span>
          <input className={field} name="uf" pattern="[A-Za-z]{2}" maxLength={2} defaultValue={site?.uf ?? ''} />
        </label>
        <label className="space-y-1 text-sm"><span>Criticidade</span>
          <select className={field} name="criticality" defaultValue={site?.criticality ?? 'media'}>
            <option value="critica">Crítica</option>
            <option value="alta">Alta</option>
            <option value="media">Média</option>
            <option value="baixa">Baixa</option>
          </select>
        </label>
        <CatalogField name="concession_id" label="Concessão" initial={String(site?.concession_id ?? '')}
          choices={catalogs?.concessions ?? []} disabled={!catalogs} />
        <CatalogField name="locality_type_id" label="Tipo de localidade" initial={String(site?.locality_type_id ?? '')}
          choices={catalogs?.localityTypes ?? []} disabled={!catalogs} />
      </fieldset>
      {catalogError && <p role="alert" className="text-sm text-amber-200">{catalogError}</p>}
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
      <div className="flex gap-2">
        <button className={button} type="submit" disabled={pending}>{pending ? 'Salvando…' : 'Salvar site'}</button>
        <button className={button} type="button" disabled={pending} onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}

export function PostgresSiteCoordinates({ tenant, site, onCancel, onSaved }: {
  tenant: string;
  site: Site;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const latitude = String(data.get('latitude') ?? '').trim();
    const longitude = String(data.get('longitude') ?? '').trim();
    if (!latitude || !longitude || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) {
      setError('Informe latitude e longitude válidas.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await request('/inventory/sites/' + site.id + '/verify-coords', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: JSON.stringify({ latitude: Number(latitude), longitude: Number(longitude) }),
      });
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={verify}>
      <h3 className="font-semibold">Verificar coordenadas de {site.name}</h3>
      <p className="text-sm text-slate-300">Informe as coordenadas conferidas, em graus decimais.</p>
      <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Latitude</span>
          <input className={field} name="latitude" type="number" min={-90} max={90} step="any"
            defaultValue={site.latitude ?? ''} required />
        </label>
        <label className="space-y-1 text-sm"><span>Longitude</span>
          <input className={field} name="longitude" type="number" min={-180} max={180} step="any"
            defaultValue={site.longitude ?? ''} required />
        </label>
      </fieldset>
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
      <div className="flex gap-2">
        <button className={button} type="submit" disabled={pending}>{pending ? 'Verificando…' : 'Confirmar coordenadas'}</button>
        <button className={button} type="button" disabled={pending} onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
