import { useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { button, field, Message, PagedData } from './PostgresInventoryFields.tsx';

const roles = { tenant_admin: 'Administrador', tenant_operator: 'Operador', tenant_viewer: 'Leitor' };
type User = { id: string; email: string; full_name: string; role: keyof typeof roles; is_active: boolean };
const path = '/tenant-users';

export function PostgresTenantUsers({ tenant, actor }: { tenant: string; actor: string }) {
  const [showForm, setShowForm] = useState(false);
  const [pending, setPending] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function save(destination: string, method: 'POST' | 'PATCH', body: object, message: string) {
    setPending(true);
    setError('');
    setNotice('');
    try {
      await request(destination, {
        method,
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
      });
      setShowForm(false);
      setNotice(message);
      setRevision(previous => previous + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = Object.fromEntries(new FormData(form));
    const password = form.elements.namedItem('password');
    if (password instanceof HTMLInputElement) password.value = '';
    void save(path, 'POST', body, 'Usuário cadastrado.');
  }

  function changeStatus(user: User) {
    const active = !user.is_active;
    if (!active && !window.confirm(`Desativar ${user.full_name} e encerrar suas sessões?`)) return;
    void save(path + '/' + user.id + '/status', 'PATCH', { is_active: active },
      active ? 'Usuário reativado.' : 'Usuário desativado.');
  }

  return (
    <div className="space-y-4">
      {!showForm && <button type="button" className={button} disabled={pending} onClick={() => setShowForm(true)}>Novo usuário</button>}
      {showForm && (
        <form className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={create}>
          <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2" disabled={pending}>
            <label className="space-y-1 text-sm"><span>Nome completo</span>
              <input name="full_name" className={field} required maxLength={200} />
            </label>
            <label className="space-y-1 text-sm"><span>E-mail</span>
              <input name="email" className={field} type="email" required maxLength={254} />
            </label>
            <label className="space-y-1 text-sm"><span>Senha inicial</span>
              <input name="password" className={field} type="password" autoComplete="new-password" required minLength={8} maxLength={1024} />
            </label>
            <label className="space-y-1 text-sm"><span>Papel</span>
              <select name="role" className={field} defaultValue="tenant_viewer">
                {Object.entries(roles).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </fieldset>
          <div className="flex gap-2">
            <button type="submit" className={button} disabled={pending}>Cadastrar usuário</button>
            <button type="button" className={button} disabled={pending} onClick={() => { setShowForm(false); setError(''); }}>Cancelar</button>
          </div>
        </form>
      )}
      {error && <Message>{error}</Message>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      <PagedData<User> key={revision} endpoint={path} expectedTenant={tenant} render={rows => (
        <div className="overflow-x-auto rounded-md border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-900 text-slate-300">
              <tr>
                {['Nome', 'E-mail', 'Papel', 'Status', 'Ações'].map(label =>
                  <th key={label} scope="col" className="px-3 py-2">{label}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map(user => (
                <tr key={user.id} className="border-t border-slate-800">
                  <td className="px-3 py-2">{user.full_name}</td>
                  <td className="px-3 py-2">{user.email}</td>
                  <td className="px-3 py-2">{roles[user.role]}</td>
                  <td className="px-3 py-2">{user.is_active ? 'Ativo' : 'Inativo'}</td>
                  <td className="px-3 py-2">
                    {user.id !== actor && <button type="button" className={button} disabled={pending || showForm}
                      aria-label={(user.is_active ? 'Desativar ' : 'Reativar ') + user.full_name}
                      onClick={() => changeStatus(user)}>{user.is_active ? 'Desativar' : 'Reativar'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )} />
    </div>
  );
}
