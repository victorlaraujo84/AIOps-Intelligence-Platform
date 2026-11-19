import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { NocOverviewResponse } from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';
import { IncidentsTrendChart } from './IncidentsTrendChart.tsx';

interface NocOverviewViewProps {
  activeTenantId: string | null;
  onNavigate: (tab: string) => void;
}

const DOMAIN_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'Todos os domínios' },
  { value: 'ti', label: 'TI & Aplicações' },
  { value: 'rede', label: 'Redes & Telecom' },
  { value: 'iot', label: 'IoT & Sensores' },
  { value: 'energia', label: 'Energia & UPS' },
  { value: 'ambiente', label: 'Ambiente & Clima' },
  { value: 'infra', label: 'Infraestrutura Física' },
];

export function NocOverviewView({ activeTenantId, onNavigate }: NocOverviewViewProps) {
  const [data, setData] = useState<NocOverviewResponse | null>(null);
  const [domainFilter, setDomainFilter] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadOverview(domain = domainFilter) {
    if (!activeTenantId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<NocOverviewResponse>(`/api/noc/overview?domain=${encodeURIComponent(domain)}`);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao carregar visão geral.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOverview(domainFilter);
  }, [activeTenantId, domainFilter]);

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Nenhum tenant selecionado"
        description="Crie ou selecione um tenant na seção Tenants e RBAC para iniciar o inventário, serviços, conectores e monitoramento multidomínio."
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
          <h2 className="text-xl font-semibold text-slate-100">Visão Geral NOC Híbrida</h2>
          <p className="text-sm text-slate-400">
            Observabilidade multidomínio (TI, Redes, IoT, Energia e Clima) para{' '}
            <span className="font-medium text-slate-200">{data?.tenant?.name ?? activeTenantId}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Filtrar por domínio"
            value={domainFilter}
            onChange={(e) => setDomainFilter(e.target.value)}
            className="rounded-md border border-slate-700 bg-[#111827] px-3 py-2 text-xs text-slate-200"
          >
            {DOMAIN_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={() => void loadOverview(domainFilter)}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-[#111827] px-3.5 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            Atualizar Métricas
          </button>
        </div>
      </div>

      {/* KPI Grid com origem rastreável e zero dados fictícios */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Ativos e Serviços</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.assets_total : '—'}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums text-blue-400">
              {m ? `${m.services_total} serviços` : '—'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums text-slate-400">
              {m ? `${m.assets_ungeoreferenced} lógicos/sem site` : '—'}
            </span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Sites Georreferenciados</div>
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
          <div className="text-xs text-slate-400">Telemetria Separada (24h)</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.metrics_24h + m.events_24h + m.logs_24h : '—'}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 font-mono text-[11px] tabular-nums text-slate-400">
            <span>{m ? `${m.metrics_24h} métricas` : '—'}</span>
            <span aria-hidden="true">·</span>
            <span>{m ? `${m.events_24h} eventos` : '—'}</span>
            <span aria-hidden="true">·</span>
            <span>{m ? `${m.logs_24h} logs` : '—'}</span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="text-xs text-slate-400">Incidentes e Anomalias</div>
          <div className="mt-2 font-mono text-2xl font-semibold tabular-nums text-slate-100">
            {m ? m.incidents_open : '—'}
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-400">
            <span className="font-mono tabular-nums text-amber-400">
              {m ? `${m.anomalies_open} anomalias Z-Score` : '—'}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono text-slate-300">{m ? `${m.connectors_healthy}/${m.connectors_total} conectores OK` : '—'}</span>
          </div>
        </div>
      </div>

      {/* Tendência de Incidentes Abertos vs. Resolvidos (24h UTC) */}
      <IncidentsTrendChart
        data={data?.incidents_trend_24h ?? []}
        loading={loading}
        onOpenIncidents={() => onNavigate('incidents')}
      />

      {/* Distribuição por Domínio */}
      {data && data.domain_breakdown && data.domain_breakdown.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
          <div className="border-b border-slate-800 px-5 py-3 text-xs font-semibold text-slate-200">
            Inventário Real por Domínio (TI, Redes, IoT, Energia e Ambiente)
          </div>
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-5 py-2.5 font-medium">Domínio</th>
                <th className="px-5 py-2.5 text-right font-medium">Ativos</th>
                <th className="px-5 py-2.5 text-right font-medium">Serviços</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {data.domain_breakdown.map((row) => (
                <tr key={row.domain} className="hover:bg-slate-800/30">
                  <td className="px-5 py-2.5 font-mono text-slate-200">{row.domain}</td>
                  <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-200">{row.assets_count}</td>
                  <td className="px-5 py-2.5 text-right font-mono tabular-nums text-slate-300">{row.services_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Estados Honestos de Telemetria e ML */}
      <div className="space-y-4">
        {m && m.assets_total === 0 && m.sites_total === 0 && (
          <HonestStateBanner
            state="NOT_CONFIGURED"
            title="Inventário vazio neste tenant"
            description="Cadastre sites georreferenciados (para infraestrutura física) ou ativos lógicos de TI/IoT e serviços de negócio com dependências."
            actionLabel="Abrir Cadastros e Topologia"
            onAction={() => onNavigate('inventory')}
            provenance={data ? `tenant=${data.provenance.tenant_id}` : undefined}
          />
        )}

        {h && h.telemetry_status !== 'ACTIVE' && (
          <HonestStateBanner
            state={h.telemetry_status}
            title={
              h.telemetry_status === 'NOT_CONFIGURED'
                ? 'Central de integrações e coleta nativa sem fontes ativas'
                : h.telemetry_status === 'SOURCE_STALE'
                  ? 'Fontes de telemetria desatualizadas nas últimas 24h'
                  : 'Nenhuma métrica, evento ou log ingerido até o momento'
            }
            description="Configure conectores externos (Open-Meteo, Zabbix, PRTG), registre escopos autorizados de coleta nativa (SNMPv3, MQTT, ICMP, OTLP) ou importe CSV incremental."
            actionLabel="Configurar Integrações e Coleta"
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
          <span>Domínio: {data.provenance.domain_filter}</span>
          <span aria-hidden="true">·</span>
          <span>Tenant: {data.provenance.tenant_id}</span>
          <span aria-hidden="true">·</span>
          <span>Calculado em (UTC): {data.provenance.computed_at_utc}</span>
        </div>
      )}
    </div>
  );
}
