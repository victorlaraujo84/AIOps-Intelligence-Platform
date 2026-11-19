import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api.ts';
import type {
  AnomalyDetection,
  CanonicalEvent,
  Incident,
  MetricSample,
  OperationalLog,
  RcaCategory,
} from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface IncidentsRcaViewProps {
  activeTenantId: string | null;
  onNavigate: (tab: string) => void;
}

const RCA_LABELS: Record<RcaCategory, string> = {
  eletrica: 'Elétrica / Energia',
  climatica_direta: 'Climática Direta',
  composta: 'Composta (Multidomínio)',
  telecom_outros: 'Redes / Telecom',
  ti_aplicacao: 'TI / Aplicação',
  iot_sensor: 'IoT / Sensor',
  desconhecida: 'Desconhecida',
};

export function IncidentsRcaView({ activeTenantId, onNavigate }: IncidentsRcaViewProps) {
  const [tab, setTab] = useState<'incidents' | 'metrics' | 'logs' | 'anomalies' | 'events'>('incidents');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [metrics, setMetrics] = useState<MetricSample[]>([]);
  const [logs, setLogs] = useState<OperationalLog[]>([]);
  const [anomalies, setAnomalies] = useState<AnomalyDetection[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewCategory, setReviewCategory] = useState<RcaCategory>('desconhecida');
  const [reviewStatus, setReviewStatus] = useState<'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'>('ACKNOWLEDGED');
  const [reviewNote, setReviewNote] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  async function loadData() {
    if (!activeTenantId) return;
    const [incRes, evRes, metRes, logRes, anomRes] = await Promise.all([
      apiRequest<{ incidents: Incident[] }>('/api/incidents'),
      apiRequest<{ events: CanonicalEvent[] }>('/api/events'),
      apiRequest<{ metrics: MetricSample[] }>('/api/metrics?limit=100'),
      apiRequest<{ logs: OperationalLog[] }>('/api/logs?limit=100'),
      apiRequest<{ anomalies: AnomalyDetection[] }>('/api/anomalies'),
    ]);
    setIncidents(incRes.incidents);
    setEvents(evRes.events);
    setMetrics(metRes.metrics);
    setLogs(logRes.logs);
    setAnomalies(anomRes.anomalies);
  }

  useEffect(() => {
    void loadData();
  }, [activeTenantId]);

  async function submitReview(incidentId: string) {
    setFeedback(null);
    await apiRequest(`/api/incidents/${incidentId}/rca-review`, {
      method: 'PATCH',
      body: JSON.stringify({
        rca_category: reviewCategory,
        status: reviewStatus,
        review_note: reviewNote || undefined,
      }),
    });
    setReviewingId(null);
    setReviewNote('');
    setFeedback('Revisão humana de RCA registrada na trilha de auditoria.');
    await loadData();
  }

  async function updateAnomalyStatus(id: string, status: 'ACKNOWLEDGED' | 'DISMISSED') {
    setFeedback(null);
    await apiRequest(`/api/anomalies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
    setFeedback(`Anomalia marcada como ${status}.`);
    await loadData();
  }

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Selecione um tenant para visualizar incidentes, métricas, logs e anomalias"
        description="Toda a telemetria separada e correlação RCA é isolada por tenant."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Telemetria, Anomalias, Incidentes e RCA</h2>
          <p className="text-sm text-slate-400">
            Separação rigorosa entre séries temporais numéricas, logs operacionais, eventos canônicos, anomalias Z-Score e incidentes correlacionados.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 rounded-md border border-slate-800 bg-[#111827] p-1">
          {(
            [
              { id: 'incidents', label: `Incidentes (${incidents.length})` },
              { id: 'anomalies', label: `Anomalias (${anomalies.length})` },
              { id: 'metrics', label: `Métricas (${metrics.length})` },
              { id: 'logs', label: `Logs (${logs.length})` },
              { id: 'events', label: `Eventos (${events.length})` },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium ${
                tab === item.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {feedback && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-950/20 px-4 py-2.5 text-xs text-emerald-200">
          {feedback}
        </div>
      )}

      {tab === 'incidents' && (
        <>
          {incidents.length === 0 ? (
            <HonestStateBanner
              state="NO_DATA"
              title="Nenhum incidente registrado neste tenant"
              description="Incidentes são abertos apenas por eventos reais de falha (DOWN, OUTAGE, CRITICAL, POWER_LOSS) ingeridos por conectores ou coleta nativa autorizada."
              actionLabel="Ir para Integrações"
              onAction={() => onNavigate('integrations')}
            />
          ) : (
            <div className="space-y-4">
              {incidents.map((inc) => (
                <div key={inc.id} className="rounded-lg border border-slate-800 bg-[#111827] p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                        <span className="font-mono font-semibold text-amber-400">{inc.severity}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{inc.status}</span>
                        <span aria-hidden="true">·</span>
                        <span>Site: {inc.root_site_name ?? 'Lógico / Global'}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">Aberto UTC: {inc.opened_at_utc}</span>
                      </div>
                      <h3 className="text-base font-semibold text-slate-100">{inc.title}</h3>
                      <div className="text-xs text-slate-300">
                        Hipótese RCA: <span className="font-medium text-blue-300">{RCA_LABELS[inc.rca_category]}</span> ·
                        Regra: <span className="font-mono text-slate-400">{inc.rule_version}</span> · Eventos ligados:{' '}
                        <span className="font-mono tabular-nums">{inc.event_count ?? 1}</span> · Serviços impactados:{' '}
                        <span className="font-mono tabular-nums text-amber-300">{inc.impacted_services_count ?? 0}</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setReviewingId(inc.id);
                        setReviewCategory(inc.rca_category);
                        setReviewStatus(inc.status);
                      }}
                      className="rounded border border-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
                    >
                      Revisar / Corrigir RCA
                    </button>
                  </div>

                  {inc.rca_evidence.length > 0 && (
                    <div className="mt-3 border-t border-slate-800/80 pt-3">
                      <div className="mb-1 text-xs font-medium text-slate-400">Evidências Rastreáveis (Sem Causalidade Absoluta)</div>
                      <ul className="space-y-1 font-mono text-[11px] text-slate-300">
                        {inc.rca_evidence.map((ev, idx) => (
                          <li key={idx}>• {ev}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {reviewingId === inc.id && (
                    <div className="mt-4 grid grid-cols-1 gap-3 rounded border border-slate-700 bg-[#0B111E] p-4 sm:grid-cols-3">
                      <select
                        value={reviewCategory}
                        onChange={(e) => setReviewCategory(e.target.value as RcaCategory)}
                        className="rounded border border-slate-700 bg-[#111827] px-2.5 py-2 text-xs text-slate-100"
                      >
                        {(Object.keys(RCA_LABELS) as RcaCategory[]).map((cat) => (
                          <option key={cat} value={cat}>
                            {RCA_LABELS[cat]}
                          </option>
                        ))}
                      </select>
                      <select
                        value={reviewStatus}
                        onChange={(e) => setReviewStatus(e.target.value as 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED')}
                        className="rounded border border-slate-700 bg-[#111827] px-2.5 py-2 text-xs text-slate-100"
                      >
                        <option value="OPEN">OPEN</option>
                        <option value="ACKNOWLEDGED">ACKNOWLEDGED</option>
                        <option value="RESOLVED">RESOLVED</option>
                      </select>
                      <input
                        placeholder="Nota de revisão humana"
                        value={reviewNote}
                        onChange={(e) => setReviewNote(e.target.value)}
                        className="rounded border border-slate-700 bg-[#111827] px-2.5 py-2 text-xs text-slate-100"
                      />
                      <div className="flex justify-end gap-2 sm:col-span-3">
                        <button
                          type="button"
                          onClick={() => setReviewingId(null)}
                          className="rounded px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => void submitReview(inc.id)}
                          className="rounded bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500"
                        >
                          Confirmar Revisão RCA
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {tab === 'anomalies' && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-4 py-3 font-medium">Detectado (UTC)</th>
                <th className="px-4 py-3 font-medium">Ativo / Métrica</th>
                <th className="px-4 py-3 text-right font-medium">Observado vs Baseline</th>
                <th className="px-4 py-3 text-right font-medium">Z-Score</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {anomalies.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    Nenhuma anomalia estatística detectada (requer &ge; 5 amostras prévias válidas por métrica/ativo).
                  </td>
                </tr>
              ) : (
                anomalies.map((an) => (
                  <tr key={an.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">{an.detected_at_utc}</td>
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-100">{an.metric_name}</div>
                      <div className="text-[11px] text-slate-400">{an.asset_name ?? 'Escopo Serviço'}</div>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-200">
                      {an.observed_value} (μ={an.baseline_mean}, σ={an.baseline_stddev})
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber-400">{an.z_score}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">{an.status}</td>
                    <td className="px-4 py-2.5 text-right">
                      {an.status === 'OPEN' && (
                        <div className="inline-flex gap-2">
                          <button
                            type="button"
                            onClick={() => void updateAnomalyStatus(an.id, 'ACKNOWLEDGED')}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                          >
                            Reconhecer
                          </button>
                          <button
                            type="button"
                            onClick={() => void updateAnomalyStatus(an.id, 'DISMISSED')}
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-400 hover:bg-slate-800"
                          >
                            Descartar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'metrics' && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-4 py-3 font-medium">Observed (UTC)</th>
                <th className="px-4 py-3 font-medium">Métrica</th>
                <th className="px-4 py-3 text-right font-medium">Valor / Unidade</th>
                <th className="px-4 py-3 font-medium">Ativo / Serviço / Site</th>
                <th className="px-4 py-3 font-medium">Fonte / Qualidade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {metrics.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    Nenhuma amostra de série temporal ingerida ainda (NO_DATA).
                  </td>
                </tr>
              ) : (
                metrics.map((m) => (
                  <tr key={m.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">{m.observed_at_utc}</td>
                    <td className="px-4 py-2.5 font-mono text-slate-100">{m.metric_name}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-400">
                      {m.value_num} {m.unit}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">
                      {m.asset_name ?? m.service_name ?? m.site_code ?? '—'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">
                      {m.source} · {m.quality_flag}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'logs' && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-4 py-3 font-medium">Observed (UTC)</th>
                <th className="px-4 py-3 font-medium">Severidade</th>
                <th className="px-4 py-3 font-medium">Origem / Entidade</th>
                <th className="px-4 py-3 font-medium">Mensagem</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                    Nenhum log operacional ingerido ainda (NO_DATA).
                  </td>
                </tr>
              ) : (
                logs.map((l) => (
                  <tr key={l.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">{l.observed_at_utc}</td>
                    <td
                      className={`px-4 py-2.5 font-mono text-[11px] font-semibold ${
                        l.severity === 'ERROR' || l.severity === 'FATAL'
                          ? 'text-red-400'
                          : l.severity === 'WARN'
                            ? 'text-amber-400'
                            : 'text-slate-300'
                      }`}
                    >
                      {l.severity}
                    </td>
                    <td className="px-4 py-2.5 text-slate-300">
                      <span className="font-mono">{l.source}</span>
                      {(l.asset_name || l.service_name) && (
                        <span className="text-slate-400"> · {l.asset_name ?? l.service_name}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-200">{l.message}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'events' && (
        <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-4 py-3 font-medium">Observed (UTC)</th>
                <th className="px-4 py-3 font-medium">Site / Ativo</th>
                <th className="px-4 py-3 font-medium">Fonte / Tipo</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Qualidade</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {events.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                    Nenhum evento canônico ingerido ainda (NO_DATA).
                  </td>
                </tr>
              ) : (
                events.map((ev) => (
                  <tr key={ev.id} className="hover:bg-slate-800/30">
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">
                      <div>{ev.observed_at_utc}</div>
                      {ev.forecast_issued_at_utc && (
                        <div className="text-slate-500">issued: {ev.forecast_issued_at_utc}</div>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-slate-200">
                      {ev.site_code ?? 'Lógico'} · {ev.asset_name ?? 'Site'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">
                      {ev.source} / {ev.event_type}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-100">{ev.status}</td>
                    <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">{ev.quality_flag}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
