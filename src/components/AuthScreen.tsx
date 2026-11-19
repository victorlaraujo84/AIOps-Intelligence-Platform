import { useState, type FormEvent } from 'react';
import { Lock, ShieldCheck } from 'lucide-react';
import { apiRequest, setAuthToken } from '../lib/api.ts';
import type { AuthUser } from '../shared/types.ts';

interface AuthScreenProps {
  bootstrapRequired: boolean;
  onAuthenticated: (user: AuthUser) => void;
}

export function AuthScreen({ bootstrapRequired, onAuthenticated }: AuthScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [initialTenantName, setInitialTenantName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (bootstrapRequired) {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/bootstrap', {
          method: 'POST',
          body: JSON.stringify({
            email,
            full_name: fullName,
            password,
            initial_tenant_name: initialTenantName.trim() || undefined,
          }),
        });
        if (res.token) setAuthToken(res.token);
        onAuthenticated(res.user);
      } else {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        if (res.token) setAuthToken(res.token);
        onAuthenticated(res.user);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha na autenticação.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0B111E] px-4 py-12">
      <div className="w-full max-w-md rounded-lg border border-slate-800 bg-[#111827] p-8">
        <div className="mb-6 space-y-2 border-b border-slate-800 pb-5">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {bootstrapRequired ? (
              <ShieldCheck className="h-4 w-4 text-blue-400" aria-hidden="true" />
            ) : (
              <Lock className="h-4 w-4 text-blue-400" aria-hidden="true" />
            )}
            <span>AIOps Intelligence Platform</span>
            <span aria-hidden="true">·</span>
            <span>{bootstrapRequired ? 'Inicialização Segura' : 'Acesso NOC'}</span>
          </div>
          <h1 className="text-xl font-semibold text-slate-100">
            {bootstrapRequired ? 'Criar Primeiro Super Admin' : 'Entrar no Console NOC'}
          </h1>
          <p className="text-sm text-slate-400">
            {bootstrapRequired
              ? 'O banco de dados está vazio. Crie o primeiro administrador global (super_admin) para habilitar o ambiente multi-tenant.'
              : 'Autentique-se com suas credenciais corporativas. Todas as sessões e trocas de tenant são auditadas.'}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {bootstrapRequired && (
            <div>
              <label htmlFor="fullName" className="mb-1.5 block text-xs font-medium text-slate-300">
                Nome completo
              </label>
              <input
                id="fullName"
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Ex.: Ana Paula Silva"
                className="w-full rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          <div>
            <label htmlFor="email" className="mb-1.5 block text-xs font-medium text-slate-300">
              E-mail corporativo
            </label>
            <input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="operador@empresa.com.br"
              className="w-full rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1.5 block text-xs font-medium text-slate-300">
              Senha (mínimo 8 caracteres)
            </label>
            <input
              id="password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              className="w-full rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
            />
          </div>

          {bootstrapRequired && (
            <div>
              <label htmlFor="initialTenant" className="mb-1.5 block text-xs font-medium text-slate-300">
                Primeiro Tenant (opcional — pode criar depois)
              </label>
              <input
                id="initialTenant"
                type="text"
                value={initialTenantName}
                onChange={(e) => setInitialTenantName(e.target.value)}
                placeholder="Ex.: Operação Regional Sul"
                className="w-full rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>
          )}

          {error && (
            <div role="alert" className="rounded-md border border-red-500/40 bg-red-950/30 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-md bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting
              ? 'Processando...'
              : bootstrapRequired
                ? 'Inicializar Plataforma'
                : 'Acessar Console'}
          </button>
        </form>
      </div>
    </div>
  );
}
