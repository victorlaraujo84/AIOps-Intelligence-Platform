import { useEffect, useState } from 'react';
import { apiRequest } from '../lib/api.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface MlGovernanceViewProps {
  activeTenantId: string | null;
  initialSection: 'ml-lab' | 'backtesting' | 'predictions';
}

interface MlStatusPayload {
  tenant_id: string;
  model_status: 'MODEL_NOT_VALIDATED';
  prediction_status: 'PREDICTION_UNAVAILABLE';
  backtest_status: 'INSUFFICIENT_DATA' | 'MODEL_NOT_VALIDATED';
  shadow_mode_enforced: boolean;
  dataset_summary: {
    canonical_events_count: number;
    incidents_count: number;
    minimum_events_recommended_for_split: number;
  };
  candidate_models: Array<{ code: string; name: string; status: string }>;
  ablations: string[];
  execution_note: string;
}

export function MlGovernanceView({ activeTenantId, initialSection }: MlGovernanceViewProps) {
  const [section, setSection] = useState<'ml-lab' | 'backtesting' | 'predictions'>(initialSection);
  const [data, setData] = useState<MlStatusPayload | null>(null);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (!activeTenantId) return;
    void apiRequest<MlStatusPayload>('/api/ml/status').then(setData).catch(() => setData(null));
  }, [activeTenantId]);

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Selecione um tenant para consultar governança de ML"
        description="Modelos, datasets, backtesting e previsões são estritamente isolados por tenant."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">
            {section === 'ml-lab'
              ? 'Laboratório de Machine Learning Local'
              : section === 'backtesting'
                ? 'Backtesting Cronológico e Calibração'
                : 'Previsões, SHAP e Shadow Mode'}
          </h2>
          <p className="text-sm text-slate-400">
            Motores LightGBM e XGBoost executam localmente em Python sem dependência de LLM. Riscos nunca são simulados.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#111827] p-1">
          <button
            type="button"
            onClick={() => setSection('ml-lab')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              section === 'ml-lab' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Laboratório ML
          </button>
          <button
            type="button"
            onClick={() => setSection('backtesting')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              section === 'backtesting' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Backtesting e Ablações
          </button>
          <button
            type="button"
            onClick={() => setSection('predictions')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              section === 'predictions' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Previsões e Shadow Mode
          </button>
        </div>
      </div>

      <HonestStateBanner
        state={
          section === 'predictions'
            ? 'PREDICTION_UNAVAILABLE'
            : section === 'backtesting' && data?.backtest_status === 'INSUFFICIENT_DATA'
              ? 'INSUFFICIENT_DATA'
              : 'MODEL_NOT_VALIDATED'
        }
        title={
          section === 'predictions'
            ? 'Previsões bloqueadas até aprovação formal de modelo validado'
            : 'Nenhum artefato de modelo validado registrado para este tenant'
        }
        description={
          data
            ? `Dataset real atual do tenant: ${data.dataset_summary.canonical_events_count} eventos canônicos e ${data.dataset_summary.incidents_count} incidentes. ${data.execution_note}`
            : 'Carregando metadados reais do dataset do tenant...'
        }
        provenance={`shadow_mode=ENFORCED · tenant=${activeTenantId}`}
      />

      {section === 'ml-lab' && data && (
        <div className="rounded-lg border border-slate-800 bg-[#111827]">
          <div className="border-b border-slate-800 px-5 py-3.5 text-sm font-semibold text-slate-100">
            Comparativo Obrigatório de Modelos (A–E)
          </div>
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="px-5 py-3 font-medium">Modelo</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 text-right font-medium">PR-AUC</th>
                <th className="px-5 py-3 text-right font-medium">Brier Score</th>
                <th className="px-5 py-3 text-right font-medium">Precision@K</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {data.candidate_models.map((m) => (
                <tr key={m.code}>
                  <td className="px-5 py-3 font-medium text-slate-200">{m.name}</td>
                  <td className="px-5 py-3 font-mono text-[11px] text-amber-400">{m.status}</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-500">—</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-500">—</td>
                  <td className="px-5 py-3 text-right font-mono tabular-nums text-slate-500">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {section === 'backtesting' && data && (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          <div className="rounded-lg border border-slate-800 bg-[#111827] p-5 space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">Regras Anti-Leakage e Splits Cronológicos</h3>
            <ul className="space-y-2 text-xs text-slate-300">
              <li>• Observações somente com <span className="font-mono text-slate-100">ingested_at_utc &lt;= t</span>.</li>
              <li>• Previsões históricas somente com <span className="font-mono text-slate-100">forecast_issued_at_utc &lt;= t</span>.</li>
              <li>• Embargo compatível com lookback e horizontes H = 1h, 3h e 6h.</li>
              <li>• Reamostragem/pesos permitidos apenas no conjunto de treino; prevalência real preservada em validação e holdout.</li>
              <li>• Intervalos de confiança via bootstrap agrupado por site, incidente e bloco temporal.</li>
            </ul>
          </div>

          <div className="rounded-lg border border-slate-800 bg-[#111827] p-5 space-y-3">
            <h3 className="text-sm font-semibold text-slate-100">Trilhas de Ablação com Mesmo Split</h3>
            <div className="space-y-2">
              {data.ablations.map((ab) => (
                <div key={ab} className="flex items-center justify-between rounded border border-slate-800 bg-[#0B111E] px-3 py-2 text-xs">
                  <span className="font-medium text-slate-200">{ab}</span>
                  <span className="font-mono text-[11px] text-amber-400">{data.backtest_status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {section === 'predictions' && (
        <div className="rounded-lg border border-slate-800 bg-[#111827] p-5 space-y-3">
          <h3 className="text-sm font-semibold text-slate-100">Política de Shadow Mode e Interpretabilidade SHAP</h3>
          <p className="text-xs leading-relaxed text-slate-400">
            Todas as operações preventivas iniciam em <span className="font-mono text-slate-200">Shadow Mode</span>.
            Valores SHAP serão exibidos exclusivamente como contribuição aditiva ao score do modelo — nunca como prova de causalidade nem probabilidade direta de risco. Promoção para operação assistida exige aprovação humana auditada e decisão GO no relatório de validação.
          </p>
        </div>
      )}
    </div>
  );
}
