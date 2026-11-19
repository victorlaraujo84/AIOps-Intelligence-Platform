import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api.ts';
import type { CanonicalEvent, Incident, RcaCategory } from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface IncidentsRcaViewProps {
  activeTenantId: string | null;
  onNavigate: (tab: string) => void;
}

const RCA_LABELS: Record<RcaCategory, string> = {
  eletrica: 'Elétrica',
  climatica_direta: 'Climática Direta',
  composta: 'Composta (Energia + Clima)',
  telecom_outros: 'Telecom / Outros',
  desconhecida: 'Desconhecida',
};

export function IncidentsRcaView({ activeTenantId, onNavigate }: IncidentsRcaViewProps) {
  const [tab, setTab] = useState<'incidents' | 'events'>('incidents');
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [events, setEvents] = useState<CanonicalEvent[]>([]);
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  const [reviewCategory, setReviewCategory] = useState<RcaCategory>('desconhecida');
  const [reviewStatus, setReviewStatus] = useState<'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED'>('ACKNOWLEDGED');
  const [reviewNote, setReviewNote] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  async function loadData() {
    if (!activeTenantId) return;
    const [incRes, evRes] = await Promise.all([
      apiRequest<{ incidents: Incident[] }>('/api/incidents'),
      apiRequest<{ events: CanonicalEvent[] }>('/api/events'),
    ]);
    setIncidents(incRes.incidents);
    setEvents(evRes.events);
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

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Selecione um tenant para visualizar incidentes e eventos"
        description="Eventos canônicos e incidentes correlacionados são isolados por tenant."
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Eventos, Incidentes e RCA</h2>
          <p className="text-sm text-slate-400">
            Separação entre evento bruto, incidente correlacionado e hipótese de causa raiz revisada por operador.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#111827] p-1">
          <button
            type="button"
            onClick={() => setTab('incidents')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              tab === 'incidents' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Incidentes e RCA ({incidents.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('events')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              tab === 'events' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Eventos Canônicos ({events.length})
          </button>
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
              description="Incidentes são criados automaticamente apenas a partir de eventos reais ingeridos pela Central de Integrações (ex.: quedas de energia, links DOWN ou alertas críticos)."
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
                        <span>Site: {inc.root_site_name ?? 'Global'}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">Aberto UTC: {inc.opened_at_utc}</span>
                      </div>
                      <h3 className="text-base font-semibold text-slate-100">{inc.title}</h3>
                      <div className="text-xs text-slate-300">
                        Hipótese RCA: <span className="font-medium text-blue-300">{RCA_LABELS[inc.rca_category]}</span> ·
                        Regra: <span className="font-mono text-slate-400">{inc.rule_version}</span> · Eventos ligados:{' '}
                        <span className="font-mono tabular-nums">{inc.event_count ?? 1}</span>
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
                      <div className="mb-1 text-xs font-medium text-slate-400">Evidências Rastreáveis</div>
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
                      {ev.site_code ?? '—'} · {ev.asset_name ?? 'Site'}
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
