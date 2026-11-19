import { useEffect, useState, type FormEvent } from 'react';
import { Download, Shield } from 'lucide-react';
import { apiRequest, downloadProtectedFile } from '../lib/api.ts';
import type { AiAgentConfig, AiAgentMode, AuditLog } from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface ReportsAuditAiViewProps {
  activeTenantId: string | null;
}

export function ReportsAuditAiView({ activeTenantId }: ReportsAuditAiViewProps) {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [aiMode, setAiMode] = useState<AiAgentMode>('offline');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [dataSharingAuthorized, setDataSharingAuthorized] = useState(false);
  const [timeoutMs, setTimeoutMs] = useState('15000');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  async function loadAll() {
    const logsRes = await apiRequest<{ logs: AuditLog[] }>('/api/audit-logs');
    setLogs(logsRes.logs);

    if (activeTenantId) {
      const aiRes = await apiRequest<{ config: AiAgentConfig }>('/api/ai-agent/config');
      setAiMode(aiRes.config.mode);
      setEndpointUrl(aiRes.config.endpoint_url ?? '');
      setModelName(aiRes.config.model_name ?? '');
      setHasKey(aiRes.config.has_api_key);
      setDataSharingAuthorized(aiRes.config.data_sharing_authorized);
      setTimeoutMs(String(aiRes.config.timeout_ms));
    }
  }

  useEffect(() => {
    void loadAll();
  }, [activeTenantId]);

  async function handleSaveAiConfig(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/ai-agent/config', {
        method: 'PUT',
        body: JSON.stringify({
          mode: aiMode,
          endpoint_url: endpointUrl || undefined,
          api_key: apiKey || undefined,
          model_name: modelName || undefined,
          data_sharing_authorized: dataSharingAuthorized,
          timeout_ms: Number(timeoutMs || 15000),
        }),
      });
      setApiKey('');
      setFeedback({ type: 'ok', msg: 'Configuração do Agente de IA salva e auditada.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao salvar configuração.' });
    }
  }

  async function triggerDownload(format: 'csv' | 'json' | 'markdown') {
    setFeedback(null);
    try {
      const ext = format === 'markdown' ? 'md' : format;
      await downloadProtectedFile(`/api/reports/export?format=${format}`, `relatorio-tenant.${ext}`);
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao exportar relatório.' });
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-100">Relatórios, Auditoria e Agente de IA</h2>
        <p className="text-sm text-slate-400">
          Exportação isolada por tenant, trilha de auditoria imutável e configuração explícita do provedor de IA (OpenAI, Ollama ou Offline).
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
        {/* Exportação de relatórios */}
        <div className="space-y-4 rounded-lg border border-slate-800 bg-[#111827] p-5">
          <h3 className="text-sm font-semibold text-slate-100">Exportação de Relatórios do Tenant</h3>
          {!activeTenantId ? (
            <HonestStateBanner
              state="NOT_CONFIGURED"
              title="Selecione um tenant para exportar relatórios"
              description="Os relatórios exportáveis refletem estritamente os dados persistidos do tenant ativo."
            />
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-slate-400">
                Cada exportação gera registro automático na trilha de auditoria e respeita o isolamento de tenant.
              </p>
              <div className="flex flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => triggerDownload('csv')}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Sites (CSV)
                </button>
                <button
                  type="button"
                  onClick={() => triggerDownload('json')}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Inventário Completo (JSON)
                </button>
                <button
                  type="button"
                  onClick={() => triggerDownload('markdown')}
                  className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Validation Report (MD)
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Agente de IA Híbrido */}
        <form onSubmit={handleSaveAiConfig} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Shield className="h-4 w-4 text-blue-400" aria-hidden="true" />
            Agente de IA Híbrido (Opcional)
          </div>
          <p className="text-xs text-slate-400">
            O agente nunca altera dados brutos, não inventa probabilidades e não promove modelos. Padrão: offline.
          </p>

          <div className="grid grid-cols-2 gap-2.5">
            <select
              value={aiMode}
              onChange={(e) => setAiMode(e.target.value as AiAgentMode)}
              className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="offline">Modo Offline (Sem LLM)</option>
              <option value="ollama">Ollama Local</option>
              <option value="openai">OpenAI API</option>
            </select>
            <input
              type="number"
              min={1000}
              max={60000}
              placeholder="Timeout (ms)"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
              className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
            />
          </div>

          {aiMode !== 'offline' && (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                <input
                  placeholder={aiMode === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'}
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
                />
                <input
                  placeholder={aiMode === 'ollama' ? 'Modelo (ex: llama3.1)' : 'Modelo (ex: gpt-4o-mini)'}
                  value={modelName}
                  onChange={(e) => setModelName(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
                />
              </div>
              {aiMode === 'openai' && (
                <input
                  type="password"
                  placeholder={hasKey ? 'Chave já configurada (informe para substituir)' : 'API Key (cifrada em repouso)'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
                />
              )}
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={dataSharingAuthorized}
                  onChange={(e) => setDataSharingAuthorized(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-900 text-blue-600"
                />
                Autorizo explicitamente o envio de resumos operacionais deste tenant para este provedor.
              </label>
            </>
          )}

          <button
            type="submit"
            disabled={!activeTenantId}
            className="rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            Salvar Política do Agente
          </button>
        </form>
      </div>

      {/* Trilha de Auditoria */}
      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
        <div className="border-b border-slate-800 px-4 py-3 text-xs font-semibold text-slate-200">
          Trilha de Auditoria Imutável (Últimos 100 eventos)
        </div>
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="border-b border-slate-800 text-slate-400">
              <th className="px-4 py-2.5 font-medium">Data/Hora (UTC)</th>
              <th className="px-4 py-2.5 font-medium">Ator</th>
              <th className="px-4 py-2.5 font-medium">Ação</th>
              <th className="px-4 py-2.5 font-medium">Recurso</th>
              <th className="px-4 py-2.5 font-medium">Origem IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  Nenhum registro de auditoria ainda.
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="hover:bg-slate-800/30">
                  <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">{log.created_at_utc}</td>
                  <td className="px-4 py-2.5 text-slate-200">
                    {log.actor_email ?? 'sistema'} <span className="font-mono text-[11px] text-slate-400">({log.actor_role ?? '—'})</span>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-blue-300">{log.action}</td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-slate-400">
                    {log.resource_type} {log.resource_id ? `· ${log.resource_id.slice(0, 8)}` : ''}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500">{log.ip_address ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
