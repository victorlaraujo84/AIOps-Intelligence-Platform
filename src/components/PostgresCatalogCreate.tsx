import { useState, type FormEvent, type ReactNode } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { button, field, Message, PagedData } from './PostgresInventoryFields.tsx';

const catalogs = {
  'asset-categories': { action: 'Nova categoria', saved: 'Categoria cadastrada.', name: 'label' },
  concessions: { action: 'Nova concessão', saved: 'Concessão cadastrada.', name: 'name' },
  'locality-types': { action: 'Novo tipo de localidade', saved: 'Tipo de localidade cadastrado.', name: 'label' },
} as const;

type Catalog = keyof typeof catalogs;

export function isWritableCatalog(resource: string): resource is Catalog {
  return Object.hasOwn(catalogs, resource);
}

export function PostgresCatalogCreate<Row extends { id: string; name?: string | number | null }>({ catalog, tenant, mayWrite, mayRemove, render }: {
  catalog: Catalog;
  tenant: string;
  mayWrite: boolean;
  mayRemove: boolean;
  render: (rows: Row[], onRemove: ((row: Row) => void) | undefined, disabled: boolean) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const config = catalogs[catalog];
  const endpoint = '/inventory/' + catalog;
  const isCategory = catalog === 'asset-categories';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const payload = Object.fromEntries([...data.entries()]
      .map(([key, value]) => [key, String(value).trim()])
      .filter(([, value]) => value !== ''));
    setError('');
    if (!payload.code || !payload[config.name] || (isCategory && !payload.domain)) {
      setError('Preencha os campos obrigatórios.');
      return;
    }
    await change(endpoint, 'POST', payload, config.saved);
  }

  async function change(path: string, method: 'POST' | 'DELETE', payload: object, message: string) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await request(path, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: JSON.stringify(payload),
      });
      setNotice(message);
      setOpen(false);
      setRevision(previous => previous + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  function remove(row: Row) {
    const confirmed = window.confirm(`Excluir a concessão “${row.name}”? Os sites vinculados ficarão sem concessão.`);
    if (confirmed) void change(endpoint + '/' + row.id, 'DELETE', {}, 'Concessão excluída.');
  }

  return (
    <div className="space-y-4">
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      {error && <Message>{error}</Message>}
      {mayWrite && !open && (
        <button type="button" className={button} disabled={pending} onClick={() => {
          setError('');
          setNotice('');
          setOpen(true);
        }}>{config.action}</button>
      )}
      {mayWrite && open && (
        <form className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={submit}>
          <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span>Código</span>
              <input name="code" className={field} maxLength={64} required />
            </label>
            <label className="space-y-1 text-sm"><span>{config.name === 'name' ? 'Nome' : 'Rótulo'}</span>
              <input name={config.name} className={field} maxLength={200} required />
            </label>
            {isCategory && (
              <label className="space-y-1 text-sm"><span>Domínio</span>
                <input name="domain" className={field} maxLength={80} required />
              </label>
            )}
            {catalog === 'concessions' && (
              <label className="space-y-1 text-sm"><span>Região (opcional)</span>
                <input name="region" className={field} maxLength={200} />
              </label>
            )}
            {!isCategory && (
              <label className="space-y-1 text-sm sm:col-span-2"><span>Descrição (opcional)</span>
                <textarea name="description" className={field} rows={3} maxLength={4000} />
              </label>
            )}
          </fieldset>
          <div className="flex gap-2">
            <button type="submit" className={button} disabled={pending}>Cadastrar</button>
            <button type="button" className={button} disabled={pending} onClick={() => {
              setOpen(false);
              setError('');
            }}>Cancelar</button>
          </div>
        </form>
      )}
      <PagedData<Row> key={revision} endpoint={endpoint}
        render={rows => render(rows, mayRemove ? remove : undefined, pending || open)} />
    </div>
  );
}
