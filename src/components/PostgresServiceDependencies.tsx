import { useEffect, useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { button, CatalogField, field, loadCatalog, Message, PagedData, type Choice } from './PostgresInventoryFields.tsx';

const roles = { primary: 'Principal', redundant: 'Redundante', supporting: 'Apoio' };
type Role = keyof typeof roles;
type Dependency = {
  id: string;
  asset_name: string | null;
  upstream_service_name: string | null;
  dependency_role: Role;
  weight: number;
};

export function PostgresServiceDependencies({ service, tenant, mayWrite, onBack }: {
  service: { id: string; name: string };
  tenant: string;
  mayWrite: boolean;
  onBack: () => void;
}) {
  const [catalogs, setCatalogs] = useState<{ assets: Choice[]; services: Choice[] }>();
  const [catalogError, setCatalogError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const path = '/inventory/services/' + service.id + '/dependencies';
  const headers = { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant };

  useEffect(() => {
    if (!mayWrite) return;
    const controller = new AbortController();
    void Promise.all([loadCatalog('assets', controller.signal), loadCatalog('services', controller.signal)])
      .then(([assets, services]) => setCatalogs({ assets, services: services.filter(item => item.id !== service.id) }))
      .catch(error => { if (!controller.signal.aborted) setCatalogError(errorMessage(error)); });
    return () => controller.abort();
  }, [mayWrite, service.id]);

  async function change(method: 'POST' | 'DELETE', payload: object, id?: string) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await request(id ? path + '/' + id : path, { method, headers, body: JSON.stringify(payload) });
      setNotice(method === 'POST' ? 'Dependência adicionada.' : 'Dependência removida.');
      setRevision(previous => previous + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const asset = form.get('asset_id') || null;
    const upstream = form.get('upstream_service_id') || null;
    const weight = Number(form.get('weight'));
    if (!asset && !upstream) {
      setError('Selecione um ativo ou serviço upstream.');
      return;
    }
    if (!Number.isFinite(weight) || weight <= 0) {
      setError('Informe um peso maior que zero.');
      return;
    }
    void change('POST', {
      asset_id: asset, upstream_service_id: upstream, dependency_role: form.get('dependency_role'), weight,
    });
  }

  return (
    <div className="space-y-4">
      <button type="button" className={button} disabled={pending} onClick={onBack}>Voltar aos serviços</button>
      <h3 className="text-lg font-semibold">Dependências de {service.name}</h3>
      {mayWrite && (
        <form key={revision} className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={add}>
          <fieldset disabled={pending || !catalogs} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <CatalogField name="asset_id" label="Ativo" choices={catalogs?.assets ?? []} initial="" disabled={false} />
            <CatalogField name="upstream_service_id" label="Serviço upstream" choices={catalogs?.services ?? []}
              initial="" disabled={false} />
            <div className="space-y-1 text-sm">
              <label htmlFor="dependency-role">Papel da dependência</label>
              <select id="dependency-role" className={field} name="dependency_role" defaultValue="primary">
                {Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <label className="space-y-1 text-sm"><span>Peso</span>
              <input className={field} name="weight" type="number" step="any" min={0} defaultValue={1} required />
            </label>
          </fieldset>
          {catalogError && <Message>{catalogError}</Message>}
          <button className={button} type="submit" disabled={pending || !catalogs}>Adicionar dependência</button>
        </form>
      )}
      {error && <Message>{error}</Message>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      <PagedData<Dependency> key={revision} endpoint={path} render={rows => (
        <div className="overflow-x-auto rounded-md border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-slate-300">
              <tr>
                {['Ativo', 'Serviço upstream', 'Papel', 'Peso'].map(label => <th key={label} scope="col" className="px-3 py-2">{label}</th>)}
                {mayWrite && <th scope="col" className="px-3 py-2">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => <tr key={row.id} className="border-t border-slate-800">
                <td className="px-3 py-2">{row.asset_name ?? '—'}</td>
                <td className="px-3 py-2">{row.upstream_service_name ?? '—'}</td>
                <td className="px-3 py-2">{roles[row.dependency_role] ?? row.dependency_role}</td>
                <td className="px-3 py-2">{row.weight}</td>
                {mayWrite && <td className="px-3 py-2">
                  <button type="button" className={button} disabled={pending} onClick={() => void change('DELETE', {}, row.id)}
                    aria-label={'Remover dependência de ' + [row.asset_name, row.upstream_service_name].filter(Boolean).join(' e ')}>
                    Remover
                  </button>
                </td>}
              </tr>)}
            </tbody>
          </table>
        </div>
      )} />
    </div>
  );
}
