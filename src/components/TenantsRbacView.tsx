import { useEffect, useState, type FormEvent } from 'react';
import { Building2, UserPlus } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { AuthUser, Role, Tenant } from '../shared/types.ts';

interface TenantsRbacViewProps {
  currentUser: AuthUser;
  activeTenantId: string | null;
  tenants: Tenant[];
  onTenantsUpdated: () => Promise<void>;
  onSwitchTenant: (tenantId: string) => Promise<void>;
}

export function TenantsRbacView({
  currentUser,
  activeTenantId,
  tenants,
  onTenantsUpdated,
  onSwitchTenant,
}: TenantsRbacViewProps) {
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [tenantName, setTenantName] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [tenantDoc, setTenantDoc] = useState('');

  const [userName, setUserName] = useState('');
  const [userEmail, setUserEmail] = useState('');
  const [userPassword, setUserPassword] = useState('');
  const [userRole, setUserRole] = useState<Role>('tenant_operator');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  const canManageUsers = currentUser.role === 'super_admin' || currentUser.role === 'tenant_admin';

  async function loadUsers() {
    if (!activeTenantId || !canManageUsers) {
      setUsers([]);
      return;
    }
    try {
      const res = await apiRequest<{ users: AuthUser[] }>('/api/users');
      setUsers(res.users);
    } catch {
      setUsers([]);
    }
  }

  useEffect(() => {
    void loadUsers();
  }, [activeTenantId, currentUser.role]);

  async function handleCreateTenant(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/tenants', {
        method: 'POST',
        body: JSON.stringify({ name: tenantName, slug: tenantSlug || undefined, document: tenantDoc || undefined }),
      });
      setTenantName('');
      setTenantSlug('');
      setTenantDoc('');
      setFeedback({ type: 'ok', msg: 'Tenant criado com taxonomias estruturais padrão.' });
      await onTenantsUpdated();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao criar tenant.' });
    }
  }

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          full_name: userName,
          email: userEmail,
          password: userPassword,
          role: userRole,
        }),
      });
      setUserName('');
      setUserEmail('');
      setUserPassword('');
      setFeedback({ type: 'ok', msg: 'Usuário criado com sucesso no tenant ativo.' });
      await loadUsers();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao criar usuário.' });
    }
  }

  async function handleToggleUser(userId: string) {
    setFeedback(null);
    try {
      await apiRequest(`/api/users/${userId}/toggle`, { method: 'PATCH' });
      await loadUsers();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao atualizar usuário.' });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-100">Gestão de Tenants, Usuários e RBAC</h2>
        <p className="text-sm text-slate-400">
          Isolamento imposto no servidor por tenant_id. Alternância de tenant por super_admin gera registro imutável na trilha de auditoria.
        </p>
      </div>

      {feedback && (
        <div
          className={`rounded-md border px-4 py-2.5 text-xs ${
            feedback.type === 'ok'
              ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-200'
              : 'border-red-500/40 bg-red-950/20 text-red-200'
          }`}
        >
          {feedback.msg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Lista e criação de Tenants */}
        <div className="space-y-4 rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">Organizações (Tenants)</h3>
            <span className="font-mono text-xs tabular-nums text-slate-400">{tenants.length} cadastrados</span>
          </div>

          <div className="divide-y divide-slate-800/80">
            {tenants.length === 0 ? (
              <div className="py-4 text-xs text-slate-500">Nenhum tenant cadastrado.</div>
            ) : (
              tenants.map((t) => (
                <div key={t.id} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-100">{t.name}</div>
                    <div className="font-mono text-xs text-slate-400">
                      slug: {t.slug} · status: {t.status}
                    </div>
                  </div>
                  {currentUser.role === 'super_admin' && (
                    <button
                      type="button"
                      onClick={() => void onSwitchTenant(t.id)}
                      disabled={activeTenantId === t.id}
                      className={`shrink-0 rounded px-3 py-1.5 text-xs font-medium ${
                        activeTenantId === t.id
                          ? 'border border-blue-500/40 bg-blue-950/40 text-blue-300'
                          : 'border border-slate-700 text-slate-200 hover:bg-slate-800'
                      }`}
                    >
                      {activeTenantId === t.id ? 'Ativo' : 'Selecionar'}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          {currentUser.role === 'super_admin' && (
            <form onSubmit={handleCreateTenant} className="space-y-3 border-t border-slate-800 pt-4">
              <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
                <Building2 className="h-4 w-4 text-blue-400" aria-hidden="true" />
                Novo Tenant
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <input
                  type="text"
                  required
                  placeholder="Nome da organização"
                  value={tenantName}
                  onChange={(e) => setTenantName(e.target.value)}
                  className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                />
                <input
                  type="text"
                  placeholder="Slug (opcional)"
                  value={tenantSlug}
                  onChange={(e) => setTenantSlug(e.target.value)}
                  className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
                />
              </div>
              <input
                type="text"
                placeholder="CNPJ / Documento (opcional)"
                value={tenantDoc}
                onChange={(e) => setTenantDoc(e.target.value)}
                className="w-full rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <button
                type="submit"
                className="rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
              >
                Criar Tenant
              </button>
            </form>
          )}
        </div>

        {/* Gestão de usuários do tenant ativo */}
        <div className="space-y-4 rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <h3 className="text-sm font-semibold text-slate-100">Usuários do Tenant Ativo</h3>
            <span className="font-mono text-xs tabular-nums text-slate-400">{users.length} registros</span>
          </div>

          {!canManageUsers ? (
            <p className="text-xs text-slate-400">
              Seu papel atual ({currentUser.role}) não tem permissão para listar ou criar usuários.
            </p>
          ) : !activeTenantId ? (
            <p className="text-xs text-slate-400">Selecione um tenant ativo para gerenciar seus usuários.</p>
          ) : (
            <>
              <div className="divide-y divide-slate-800/80">
                {users.length === 0 ? (
                  <div className="py-4 text-xs text-slate-500">Nenhum usuário vinculado a este tenant ainda.</div>
                ) : (
                  users.map((u) => (
                    <div key={u.id} className="flex items-center justify-between gap-3 py-3">
                      <div>
                        <div className="text-sm font-medium text-slate-100">{u.full_name}</div>
                        <div className="font-mono text-xs text-slate-400">
                          {u.email} · {u.role} · {u.is_active ? 'Ativo' : 'Suspenso'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleToggleUser(u.id)}
                        className="rounded border border-slate-700 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-800"
                      >
                        {u.is_active ? 'Suspender' : 'Ativar'}
                      </button>
                    </div>
                  ))
                )}
              </div>

              <form onSubmit={handleCreateUser} className="space-y-3 border-t border-slate-800 pt-4">
                <div className="flex items-center gap-2 text-xs font-medium text-slate-300">
                  <UserPlus className="h-4 w-4 text-blue-400" aria-hidden="true" />
                  Adicionar Usuário ao Tenant
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <input
                    type="text"
                    required
                    placeholder="Nome completo"
                    value={userName}
                    onChange={(e) => setUserName(e.target.value)}
                    className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                  />
                  <input
                    type="email"
                    required
                    placeholder="E-mail"
                    value={userEmail}
                    onChange={(e) => setUserEmail(e.target.value)}
                    className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <input
                    type="password"
                    required
                    minLength={8}
                    placeholder="Senha inicial (8+ chars)"
                    value={userPassword}
                    onChange={(e) => setUserPassword(e.target.value)}
                    className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                  />
                  <select
                    value={userRole}
                    onChange={(e) => setUserRole(e.target.value as Role)}
                    className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="tenant_admin">tenant_admin</option>
                    <option value="tenant_operator">tenant_operator</option>
                    <option value="tenant_viewer">tenant_viewer</option>
                  </select>
                </div>
                <button
                  type="submit"
                  className="rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
                >
                  Criar Usuário
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
