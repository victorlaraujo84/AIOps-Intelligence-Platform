import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { NocOverviewResponse } from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface NocOverviewViewProps {
  activeTenantId: string | null;
  onNavigate: (tab: string) => void;
}

export function NocOverviewView({ activeTenantId, onNavigate }: NocOverviewViewProps) {
  const [data, setData] = useState<NocOverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadOverview() {
    if (!activeTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<NocOverviewResponse>('/api/noc/overview');
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar visão geral.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOverview();
  }, [activeTenantId]);

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Nenhum tenant selecionado"
        description="Crie ou selecione um tenant na seção Tenants e RBAC para iniciar o inventário georreferenciado, conectores e monitoramento."
        actionLabel="Gerenciar Tenants"
        onAction={() => onNavigate('tenants')}
      />
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-950/20 p-5 text-sm text-red-200">
        {error}
      </div>
    );
  }

  const m = data?.metrics;
  const h = data?.honest_states;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Visão Geral NOC</h2>
          <p className="text-sm text-slate-400">
            Inventário real, integridade de fontes e governança de modelos do tenant{' '}
            <span className="font-medium text-slate-200">{data?.tenant?.name ?? activeTenantId}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadOverview()}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Atualizar Métricas
        </button>
      </div>

      {/* KPI Grid com origem rastreável e zero dados fictícios */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Sites Cadastrados</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.sites_total : '—'}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums text-emerald-400">
              {m ? `${m.sites_verified_coords} verificados` : '—'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-amber-400">
              {m ? `${m.sites_pending_coords} pendentes` : '—'}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Ativos e Topologia</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.assets_total : '—'}
          </div>
          <div className="mt-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums">
              {m ? `${m.topology_edges_total} enlaces direcionados` : '—'}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Conectores e Eventos (24h)</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.events_24h : '—'}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums">
              {m ? `${m.connectors_healthy}/${m.connectors_total} saudáveis` : '—'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-slate-300">{h?.telemetry_status ?? '—'}</span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Incidentes Abertos</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.incidents_open : '—'}
          </div>
          <div className="mt-2 text-xs text-slate-400">
            Estado RCA: <span className="font-mono text-slate-300">{h?.incidents_status ?? '—'}</span>
          </div>
        </div>
      </div>

      {/* Estados Honestos de Telemetria e ML */}
      <div className="space-y-4">
        {m && m.sites_total === 0 && (
          <HonestStateBanner
            state="NOT_CONFIGURED"
            title="Inventário georreferenciado vazio"
            description="Nenhum site cadastrado neste tenant ainda. Cadastre localidades, consulte endereços via BrasilAPI/ViaCEP e valide coordenadas reais para habilitar mapa, conectores climáticos e topologia."
            actionLabel="Cadastrar Primeiro Site"
            onAction={() => onNavigate('inventory')}
            provenance={data ? `tenant=${data.provenance.tenant_id}` : undefined}
          />
        )}

        {h && h.telemetry_status !== 'ACTIVE' && (
          <HonestStateBanner
            state={h.telemetry_status}
            title={
              h.telemetry_status === 'NOT_CONFIGURED'
                ? 'Central de integrações sem conectores configurados'
                : h.telemetry_status === 'SOURCE_STALE'
                  ? 'Fontes de telemetria desatualizadas nas últimas 24h'
                  : 'Nenhum evento canônico ingerido até o momento'
            }
            description="Configure um conector real (Open-Meteo para clima, Zabbix/PRTG para rede, energia/UPS ou webhook autenticado) para registrar eventos com timestamps em UTC e chave idempotente."
            actionLabel="Configurar Conectores"
            onAction={() => onNavigate('integrations')}
            provenance={data ? `janela=${data.provenance.window}` : undefined}
          />
        )}

        <HonestStateBanner
          state="MODEL_NOT_VALIDATED"
          title="Predição de indisponibilidade bloqueada por governança (Shadow Mode)"
          description="Nenhum modelo LightGBM, XGBoost ou Regressão Logística atingiu os critérios de validação cronológica anti-leakage e aprovação humana do NOC. Riscos futuros não são inventados."
          actionLabel="Abrir Laboratório de ML"
          onAction={() => onNavigate('ml-lab')}
          provenance="status=PREDICTION_UNAVAILABLE"
        />
      </div>

      {/* Rastreabilidade / Proveniência */}
      {data && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-800/80 pt-4 font-mono text-xs text-slate-500">
          <span>Origem: {data.provenance.source}</span>
          <span aria-hidden="true">·</span>
          <span>Tenant: {data.provenance.tenant_id}</span>
          <span aria-hidden="true">·</span>
          <span>Janela: {data.provenance.window}</span>
          <span aria-hidden="true">·</span>
          <span>Calculado em (UTC): {data.provenance.computed_at_utc}</span>
        </div>
      )}
    </div>
  );
}
