import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { button, CatalogField, field, loadCatalog, type Choice } from './PostgresInventoryFields.tsx';

type Asset = { id: string } & Record<string, string | number | null>;

export function PostgresAssetEditor({ tenant, asset, onCancel, onSaved }: {
  tenant: string;
  asset?: Asset;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [catalogs, setCatalogs] = useState<{ sites: Choice[]; categories: Choice[] }>();
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      loadCatalog('sites', controller.signal),
      loadCatalog('asset-categories', controller.signal),
    ]).then(([sites, categories]) => setCatalogs({ sites, categories }))
      .catch(error => { if (!controller.signal.aborted) setCatalogError(errorMessage(error)); });
    return () => controller.abort();
  }, []);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const site = data.has('site_id') ? data.get('site_id') : asset?.site_id;
    if (data.get('georeference_mode') === 'required' && !site) {
      setError('Selecione um site para o georreferenciamento obrigatório.');
      return;
    }
    const payload: Record<string, string | null> = {};
    for (const [name, raw] of data.entries()) {
      if (typeof raw !== 'string') continue;
      const value = raw.trim() || null;
      if (name === 'domain' && value === null) continue;
      if (!asset || value !== (asset[name] ?? null)) payload[name] = value;
    }
    if (Object.keys(payload).length === 0) {
      setError('Altere pelo menos um campo para salvar.');
      return;
    }
    setPending(true);
    setError('');
    try {
      const path = asset ? '/inventory/assets/' + asset.id : '/inventory/assets';
      await request(path, {
        method: asset ? 'PATCH' : 'POST',
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
      <h3 className="font-semibold">{asset ? 'Editar ativo' : 'Novo ativo'}</h3>
      <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Nome</span>
          <input className={field} name="name" maxLength={200} defaultValue={asset?.name ?? ''} required />
        </label>
        <label className="space-y-1 text-sm"><span>Hostname</span>
          <input className={field} name="hostname" maxLength={200} defaultValue={asset?.hostname ?? ''} />
        </label>
        <CatalogField name="site_id" label="Site" initial={String(asset?.site_id ?? '')}
          choices={catalogs?.sites ?? []} disabled={!catalogs} />
        <CatalogField name="category_id" label="Categoria" initial={String(asset?.category_id ?? '')}
          choices={catalogs?.categories ?? []} disabled={!catalogs} />
        <label className="space-y-1 text-sm"><span>Domínio</span>
          <input className={field} name="domain" maxLength={80} defaultValue={asset?.domain ?? ''}
            placeholder={asset ? undefined : 'Padrão da categoria'} required={Boolean(asset)} />
        </label>
        <div className="space-y-1 text-sm">
          <label htmlFor="asset-georeference-mode">Georreferenciamento</label>
          <select id="asset-georeference-mode" className={field} name="georeference_mode"
            defaultValue={asset?.georeference_mode ?? 'optional'}>
            <option value="none">Sem localização física</option>
            <option value="optional">Opcional</option>
            <option value="required">Site obrigatório</option>
          </select>
        </div>
        <div className="space-y-1 text-sm">
          <label htmlFor="asset-criticality">Criticidade</label>
          <select id="asset-criticality" className={field} name="criticality" defaultValue={asset?.criticality ?? 'media'}>
            <option value="critica">Crítica</option>
            <option value="alta">Alta</option>
            <option value="media">Média</option>
            <option value="baixa">Baixa</option>
          </select>
        </div>
      </fieldset>
      {catalogError && <p role="alert" className="text-sm text-amber-200">{catalogError}</p>}
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
      <div className="flex gap-2">
        <button className={button} type="submit" disabled={pending}>{pending ? 'Salvando…' : 'Salvar ativo'}</button>
        <button className={button} type="button" disabled={pending} onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
