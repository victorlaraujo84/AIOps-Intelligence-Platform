import { useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Cpu,
  Database,
  FileText,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  Map as MapIcon,
  Menu,
  Plug,
  Users,
  X,
} from 'lucide-react';
import { apiRequest, clearAuthToken } from './lib/api.ts';
import type { AuthUser, Tenant } from './shared/types.ts';
import { AuthScreen } from './components/AuthScreen.tsx';
import { NocOverviewView } from './components/NocOverviewView.tsx';
import { OperationalMapView } from './components/OperationalMapView.tsx';
import { TenantsRbacView } from './components/TenantsRbacView.tsx';
import { InventoryTopologyView } from './components/InventoryTopologyView.tsx';
import { IntegrationsView } from './components/IntegrationsView.tsx';
import { IncidentsRcaView } from './components/IncidentsRcaView.tsx';
import { MlGovernanceView } from './components/MlGovernanceView.tsx';
import { ReportsAuditAiView } from './components/ReportsAuditAiView.tsx';
import { HealthStatusBadge } from './components/HealthStatusBadge.tsx';

type NavTab =
  | 'overview'
  | 'map'
  | 'tenants'
  | 'inventory'
  | 'integrations'
  | 'incidents'
  | 'ml-lab'
  | 'backtesting'
  | 'predictions'
  | 'reports';

const NAV_ITEMS: Array<{ id: NavTab; label: string; Icon: typeof LayoutDashboard }> = [
  { id: 'overview', label: 'Visão Geral NOC', Icon: LayoutDashboard },
  { id: 'map', label: 'Mapa Operacional', Icon: MapIcon },
  { id: 'tenants', label: 'Tenants e RBAC', Icon: Users },
  { id: 'inventory', label: 'Cadastros e Topologia', Icon: Database },
  { id: 'integrations', label: 'Central de Integrações', Icon: Plug },
  { id: 'incidents', label: 'Incidentes e RCA', Icon: Activity },
  { id: 'ml-lab', label: 'Laboratório de ML', Icon: FlaskConical },
  { id: 'backtesting', label: 'Backtesting e Ablações', Icon: BarChart3 },
  { id: 'predictions', label: 'Previsões e Shadow Mode', Icon: Cpu },
  { id: 'reports', label: 'Relatórios e Auditoria', Icon: FileText },
];

export default function App() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [bootstrapRequired, setBootstrapRequired] = useState(false);
  const [bootstrapTokenRequired, setBootstrapTokenRequired] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  async function refreshSessionAndTenants(options: { silent?: boolean } = {}) {
    if (!options.silent) {
      setCheckingAuth(true);
    }
    try {
      const status = await apiRequest<{ bootstrap_required: boolean; bootstrap_token_required?: boolean }>('/api/auth/status');
      setBootstrapRequired(status.bootstrap_required);
      setBootstrapTokenRequired(Boolean(status.bootstrap_token_required));
      if (status.bootstrap_required) {
        setUser(null);
        setTenants([]);
        return;
      }
      const [me, tRes] = await Promise.all([
        apiRequest<{ user: AuthUser }>('/api/auth/me'),
        apiRequest<{ tenants: Tenant[] }>('/api/tenants'),
      ]);
      setUser(me.user);
      setTenants(tRes.tenants);
    } catch {
      clearAuthToken();
      setUser(null);
      setTenants([]);
    } finally {
      if (!options.silent) {
        setCheckingAuth(false);
      }
    }
  }

  useEffect(() => {
    void refreshSessionAndTenants();
  }, []);

  async function handleAuthenticated(authUser: AuthUser) {
    setUser(authUser);
    setBootstrapRequired(false);
    await refreshSessionAndTenants({ silent: true });
  }

  async function handleSwitchTenant(tenantId: string) {
    if (!tenantId) return;
    const switched = await apiRequest<{ active_tenant_id: string; user?: AuthUser }>('/api/auth/switch-tenant', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId }),
    });
    if (switched.user) {
      setUser(switched.user);
    }
    await refreshSessionAndTenants({ silent: true });
  }

  async function handleLogout() {
    await apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearAuthToken();
    setUser(null);
    setTenants([]);
  }

  if (checkingAuth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0B111E] text-sm text-slate-400">
        Verificando sessão segura...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        bootstrapRequired={bootstrapRequired}
        bootstrapTokenRequired={bootstrapTokenRequired}
        onAuthenticated={(u) => void handleAuthenticated(u)}
      />
    );
  }

  const activeTenantId = user.active_tenant_id;
  const activeTenant = tenants.find((t) => t.id === activeTenantId) ?? null;
  const currentNav = NAV_ITEMS.find((i) => i.id === activeTab)!;

  return (
    <div className="flex min-h-screen bg-[#0B111E] text-slate-100">
      {/* Sidebar Desktop */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-800/90 bg-[#0E1525] lg:flex">
        <div className="flex h-14 items-center border-b border-slate-800/90 px-5">
          <span className="font-display text-sm font-semibold tracking-tight text-slate-100">
            AIOps Intelligence
          </span>
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4" aria-label="Navegação principal NOC">
          {NAV_ITEMS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setActiveTab(id)}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors ${
                  active
                    ? 'bg-blue-600/15 text-blue-300'
                    : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-800/90 p-4 text-xs">
          <div className="truncate font-medium text-slate-200">{user.full_name}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-slate-400">
            {user.role} · {activeTenant?.slug ?? 'sem tenant'}
          </div>
          <button
            type="button"
            onClick={() => void handleLogout()}
            className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sair
          </button>
        </div>
      </aside>

      {/* Drawer Mobile */}
      {mobileNavOpen && (
        <div className="fixed inset-0 z-50 flex lg:hidden">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileNavOpen(false)} />
          <aside className="relative z-10 flex w-64 flex-col border-r border-slate-800 bg-[#0E1525]">
            <div className="flex h-14 items-center justify-between border-b border-slate-800 px-4">
              <span className="font-display text-sm font-semibold text-slate-100">AIOps Intelligence</span>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="rounded p-1.5 text-slate-400 hover:bg-slate-800"
                aria-label="Fechar menu"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
              {NAV_ITEMS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setActiveTab(id);
                    setMobileNavOpen(false);
                  }}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-xs font-medium ${
                    activeTab === id ? 'bg-blue-600/15 text-blue-300' : 'text-slate-400 hover:bg-slate-800/60'
                  }`}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
          </aside>
        </div>
      )}

      {/* Main Content */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-slate-800/90 bg-[#0E1525] px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileNavOpen(true)}
              className="rounded p-1.5 text-slate-400 hover:bg-slate-800 lg:hidden"
              aria-label="Abrir navegação"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>Console NOC</span>
              <span aria-hidden="true">/</span>
              <span className="font-medium text-slate-100">{currentNav.label}</span>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <HealthStatusBadge />

            {user.role === 'super_admin' && tenants.length > 0 && (
              <select
                aria-label="Selecionar tenant ativo"
                value={activeTenantId ?? ''}
                onChange={(e) => void handleSwitchTenant(e.target.value)}
                className="max-w-[200px] rounded border border-slate-700 bg-[#0B111E] px-2.5 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
              >
                {!activeTenantId && <option value="">Selecionar tenant...</option>}
                {tenants.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}

            {user.role !== 'super_admin' && activeTenant && (
              <span className="hidden font-mono text-xs text-slate-400 sm:inline">
                Tenant: {activeTenant.name}
              </span>
            )}
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 sm:p-6">
          <div className="mx-auto max-w-7xl">
            {activeTab === 'overview' && (
              <NocOverviewView
                key={`overview-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
                onNavigate={(t) => setActiveTab(t as NavTab)}
              />
            )}
            {activeTab === 'map' && (
              <OperationalMapView
                key={`map-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
                onNavigate={(t) => setActiveTab(t as NavTab)}
              />
            )}
            {activeTab === 'tenants' && (
              <TenantsRbacView
                currentUser={user}
                activeTenantId={activeTenantId}
                tenants={tenants}
                onTenantsUpdated={() => refreshSessionAndTenants({ silent: true })}
                onSwitchTenant={handleSwitchTenant}
              />
            )}
            {activeTab === 'inventory' && (
              <InventoryTopologyView
                key={`inventory-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
              />
            )}
            {activeTab === 'integrations' && (
              <IntegrationsView
                key={`integrations-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
              />
            )}
            {activeTab === 'incidents' && (
              <IncidentsRcaView
                key={`incidents-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
                onNavigate={(t) => setActiveTab(t as NavTab)}
              />
            )}
            {(activeTab === 'ml-lab' || activeTab === 'backtesting' || activeTab === 'predictions') && (
              <MlGovernanceView
                key={`ml-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
                initialSection={activeTab}
              />
            )}
            {activeTab === 'reports' && (
              <ReportsAuditAiView
                key={`reports-${activeTenantId ?? 'none'}`}
                activeTenantId={activeTenantId}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
