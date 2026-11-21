import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { button, CatalogField, field, loadCatalog, Message, PagedData, type Choice } from './PostgresInventoryFields.tsx';

type Edge = {
  id: string;
  source_asset_name: string;
  target_asset_name: string;
  link_type: string;
  provider_name: string | null;
  capacity_mbps: number | null;
  is_redundant: boolean;
};

const path = '/inventory/topology/edges';

export function PostgresTopology({ tenant, mayWrite }: { tenant: string; mayWrite: boolean }) {
  const [assets, setAssets] = useState<Choice[]>();
  const [catalogError, setCatalogError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!mayWrite || !showForm) return;
    const controller = new AbortController();
    void loadCatalog('assets', controller.signal)
      .then(setAssets)
      .catch(error => { if (!controller.signal.aborted) setCatalogError(errorMessage(error)); });
    return () => controller.abort();
  }, [mayWrite, showForm]);

  async function change(method: 'POST' | 'DELETE', payload: object, edge?: Edge) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await request(edge ? path + '/' + edge.id : path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: JSON.stringify(payload),
      });
      if (method === 'POST') setShowForm(false);
      setNotice(method === 'POST' ? 'Enlace cadastrado.' : 'Enlace removido.');
      setRevision(previous => previous + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const source = form.get('source_asset_id');
    const target = form.get('target_asset_id');
    if (source === target) {
      setError('Selecione ativos diferentes para origem e destino.');
      return;
    }
    const linkType = String(form.get('link_type')).trim();
    if (!linkType) {
      setError('Informe o tipo de enlace.');
      return;
    }
    const capacity = form.get('capacity_mbps');
    void change('POST', {
      source_asset_id: source,
      target_asset_id: target,
      link_type: linkType,
      provider_name: String(form.get('provider_name')).trim() || null,
      capacity_mbps: capacity === '' ? null : Number(capacity),
      is_redundant: form.has('is_redundant'),
    });
  }

  function showEditor(open: boolean) {
    setError('');
    setCatalogError('');
    setAssets(undefined);
    setShowForm(open);
  }

  return (
    <div className="space-y-4">
      {mayWrite && !showForm && <button type="button" className={button} disabled={pending}
        onClick={() => showEditor(true)}>Novo enlace</button>}
      {mayWrite && showForm && (
        <form className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={submit}>
          <fieldset disabled={pending || !assets} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <CatalogField name="source_asset_id" label="Ativo de origem" choices={assets ?? []} initial="" disabled={false} required />
            <CatalogField name="target_asset_id" label="Ativo de destino" choices={assets ?? []} initial="" disabled={false} required />
            <label className="space-y-1 text-sm"><span>Tipo de enlace</span>
              <input className={field} name="link_type" maxLength={200} required />
            </label>
            <label className="space-y-1 text-sm"><span>Provedor</span>
              <input className={field} name="provider_name" maxLength={200} />
            </label>
            <label className="space-y-1 text-sm"><span>Capacidade (Mbps)</span>
              <input className={field} name="capacity_mbps" type="number" min={0} step="any" />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input name="is_redundant" type="checkbox" /> Enlace redundante
            </label>
          </fieldset>
          {!assets && !catalogError && <p role="status" className="text-sm text-slate-400">Carregando ativos…</p>}
          {catalogError && <Message>{catalogError}</Message>}
          {assets && assets.length < 2 && <p className="text-sm text-slate-300">Cadastre dois ativos para criar um enlace.</p>}
          <div className="flex gap-2">
            <button className={button} type="submit" disabled={pending || (assets?.length ?? 0) < 2}>Cadastrar enlace</button>
            <button className={button} type="button" disabled={pending} onClick={() => showEditor(false)}>Cancelar</button>
          </div>
        </form>
      )}
      {error && <Message>{error}</Message>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      <PagedData<Edge> key={revision} endpoint={path} render={rows => (
        <div className="overflow-x-auto rounded-md border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-slate-300">
              <tr>
                {['Origem', 'Destino', 'Tipo', 'Provedor', 'Capacidade (Mbps)', 'Redundante'].map(label =>
                  <th key={label} scope="col" className="px-3 py-2">{label}</th>
                )}
                {mayWrite && <th scope="col" className="px-3 py-2">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => <tr key={row.id} className="border-t border-slate-800">
                <td className="px-3 py-2">{row.source_asset_name}</td>
                <td className="px-3 py-2">{row.target_asset_name}</td>
                <td className="px-3 py-2">{row.link_type}</td>
                <td className="px-3 py-2">{row.provider_name ?? '—'}</td>
                <td className="px-3 py-2">{row.capacity_mbps ?? '—'}</td>
                <td className="px-3 py-2">{row.is_redundant ? 'Sim' : 'Não'}</td>
                {mayWrite && <td className="px-3 py-2">
                  <button type="button" className={button} disabled={pending || showForm}
                    aria-label={`Remover enlace ${row.link_type} de ${row.source_asset_name} para ${row.target_asset_name}`}
                    onClick={() => {
                      if (window.confirm(`Remover o enlace ${row.link_type} de ${row.source_asset_name} para ${row.target_asset_name}?`)) {
                        void change('DELETE', {}, row);
                      }
                    }}>Remover</button>
                </td>}
              </tr>)}
            </tbody>
          </table>
        </div>
      )} />
    </div>
  );
}
