import { useState, type FormEvent } from 'react';
import { errorMessage } from '../lib/postgres-console.ts';
import { button, field, Message } from './PostgresInventoryFields.tsx';

export type NewTenant = { name: string; slug: string; document: string };

export function PostgresTenantCreator({ busy, onCreate }: {
  busy: boolean;
  onCreate: (tenant: NewTenant) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError('');
    try {
      const name = await onCreate({
        name: String(data.get('name')),
        slug: String(data.get('slug')),
        document: String(data.get('document')),
      });
      setNotice(`Tenant ${name} cadastrado.`);
      setOpen(false);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  return (
    <div className="space-y-3">
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      {!open && (
        <button type="button" className={button} disabled={busy} onClick={() => {
          setNotice('');
          setOpen(true);
        }}>Novo tenant</button>
      )}
      {open && (
        <form className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={submit}>
          <fieldset disabled={busy} className="grid min-w-0 gap-3 sm:grid-cols-3">
            <label className="space-y-1 text-sm"><span>Nome do tenant</span>
              <input name="name" className={field} required minLength={2} maxLength={200} />
            </label>
            <label className="space-y-1 text-sm"><span>Identificador (opcional)</span>
              <input name="slug" className={field} maxLength={200} />
            </label>
            <label className="space-y-1 text-sm"><span>Documento (opcional)</span>
              <input name="document" className={field} maxLength={80} />
            </label>
          </fieldset>
          {error && <Message>{error}</Message>}
          <div className="flex gap-2">
            <button type="submit" className={button} disabled={busy}>Cadastrar tenant</button>
            <button type="button" className={button} disabled={busy} onClick={() => {
              setError('');
              setOpen(false);
            }}>Cancelar</button>
          </div>
        </form>
      )}
    </div>
  );
}
