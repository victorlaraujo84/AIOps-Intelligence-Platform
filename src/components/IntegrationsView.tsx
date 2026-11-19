import { useEffect, useState, type FormEvent } from 'react';
import { Play, PlugZap, Trash2, Upload } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { Connector, ConnectorSyncRun, ConnectorType, Site } from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface IntegrationsViewProps {
  activeTenantId: string | null;
}

export function IntegrationsView({ activeTenantId }: IntegrationsViewProps) {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [runs, setRuns] = useState<ConnectorSyncRun[]>([]);
  const [sites, setSites] = useState<Site[]>([]);

  const [type, setType] = useState<ConnectorType>('open_meteo');
  const [name, setName] = useState('');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [authMode, setAuthMode] = useState<'none' | 'api_key' | 'bearer' | 'basic'>('none');
  const [credentials, setCredentials] = useState('');
  const [pollInterval, setPollInterval] = useState('300');
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Ingestão autenticada via Webhook/JSON real
  const [ingestConnectorId, setIngestConnectorId] = useState<string | null>(null);
  const [ingestSiteId, setIngestSiteId] = useState('');
  const [ingestEventType, setIngestEventType] = useState('power_outage');
  const [ingestStatus, setIngestStatus] = useState('DOWN');
  const [ingestSource, setIngestSource] = useState('ups_field');

  async function loadAll() {
    if (!activeTenantId) return;
    const [intRes, siteRes] = await Promise.all([
      apiRequest<{ connectors: Connector[]; sync_runs: ConnectorSyncRun[] }>('/api/integrations/connectors'),
      apiRequest<{ sites: Site[] }>('/api/sites'),
    ]);
    setConnectors(intRes.connectors);
    setRuns(intRes.sync_runs);
    setSites(siteRes.sites);
  }

  useEffect(() => {
    void loadAll();
  }, [activeTenantId]);

  async function handleCreateConnector(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/integrations/connectors', {
        method: 'POST',
        body: JSON.stringify({
          connector_type: type,
          name,
          endpoint_url: endpointUrl.trim() || undefined,
          auth_mode: authMode,
          credentials: credentials || undefined,
          poll_interval_sec: Number(pollInterval || 300),
        }),
      });
      setName('');
      setEndpointUrl('');
      setCredentials('');
      setFeedback({ type: 'ok', msg: 'Conector configurado com credenciais cifradas em repouso.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao criar conector.' });
    }
  }

  async function handleTest(id: string) {
    setBusyId(id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ ok: boolean; latency_ms: number; detail: string }>(
        `/api/integrations/connectors/${id}/test`,
        { method: 'POST' },
      );
      setFeedback({
        type: res.ok ? 'ok' : 'err',
        msg: `${res.detail} (latência: ${res.latency_ms} ms)`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao testar conector.' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleSync(id: string) {
    setBusyId(id);
    setFeedback(null);
    try {
      const res = await apiRequest<{ status: string; records_ingested: number; records_deduplicated: number; error_message?: string }>(
        `/api/integrations/connectors/${id}/sync`,
        { method: 'POST' },
      );
      setFeedback({
        type: res.status === 'ERROR' ? 'err' : 'ok',
        msg: res.error_message || `Sincronização ${res.status}: ${res.records_ingested} ingeridos, ${res.records_deduplicated} deduplicados.`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro na sincronização.' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleManualIngest(e: FormEvent) {
    e.preventDefault();
    if (!ingestConnectorId) return;
    setFeedback(null);
    const now = new Date().toISOString();
    try {
      const res = await apiRequest<{ ingested: number; deduplicated: number; created_incidents: number }>(
        `/api/integrations/connectors/${ingestConnectorId}/ingest`,
        {
          method: 'POST',
          body: JSON.stringify({
            events: [
              {
                idempotency_key: `manual:${ingestConnectorId}:${ingestSiteId || 'global'}:${now}`,
                site_id: ingestSiteId || undefined,
                event_time_utc: now,
                observed_at_utc: now,
                source: ingestSource,
                event_type: ingestEventType,
                status: ingestStatus,
              },
            ],
          }),
        },
      );
      setIngestConnectorId(null);
      setFeedback({
        type: 'ok',
        msg: `Evento canônico ingerido (${res.ingested} novo, ${res.created_incidents} incidente(s) correlacionado(s)).`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao ingerir evento.' });
    }
  }

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Selecione um tenant para gerenciar integrações"
        description="Conectores, credenciais e histórico de sincronização são estritamente isolados por tenant."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-100">Central de Integrações Reais</h2>
        <p className="text-sm text-slate-400">
          Conectores com proteção anti-SSRF, credenciais cifradas (AES-256-GCM), deduplicação por chave idempotente e rastreabilidade em UTC.
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <form onSubmit={handleCreateConnector} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
          <h3 className="text-sm font-semibold text-slate-100">Configurar Novo Conector</h3>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ConnectorType)}
            className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
          >
            <option value="open_meteo">Clima · Open-Meteo (API Pública Real)</option>
            <option value="inmet">Clima · INMET</option>
            <option value="cemaden">Clima · CEMADEN</option>
            <option value="zabbix">Rede · Zabbix API</option>
            <option value="prtg">Rede · PRTG API</option>
            <option value="snmp_trap">Rede · Traps SNMP</option>
            <option value="energy_ups">Energia · Telemetria UPS / Concessionária</option>
            <option value="webhook_csv">Genérico · Webhook / Importação CSV</option>
          </select>

          <input
            required
            placeholder="Nome do conector (ex: Open-Meteo Regional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
          />

          <input
            placeholder={type === 'open_meteo' ? 'Opcional (padrão api.open-meteo.com)' : 'Endpoint HTTPS (ex: https://zabbix.empresa.com/api_jsonrpc.php)'}
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
          />

          <div className="grid grid-cols-2 gap-2.5">
            <select
              value={authMode}
              onChange={(e) => setAuthMode(e.target.value as 'none' | 'api_key' | 'bearer' | 'basic')}
              className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="none">Sem autenticação</option>
              <option value="bearer">Bearer Token</option>
              <option value="api_key">X-API-Key</option>
              <option value="basic">Basic Auth</option>
            </select>
            <input
              type="number"
              min={60}
              placeholder="Intervalo (s)"
              value={pollInterval}
              onChange={(e) => setPollInterval(e.target.value)}
              className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
            />
          </div>

          {authMode !== 'none' && (
            <input
              type="password"
              placeholder="Token / Credencial (cifrada em repouso)"
              value={credentials}
              onChange={(e) => setCredentials(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
            />
          )}

          <button type="submit" className="w-full rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500">
            Salvar Conector
          </button>
        </form>

        <div className="space-y-4 lg:col-span-2">
          {connectors.length === 0 ? (
            <HonestStateBanner
              state="NOT_CONFIGURED"
              title="Nenhum conector configurado para este tenant"
              description="Adicione um conector ao lado. Para testar ingestão climática real imediatamente após cadastrar sites com coordenadas verificadas, utilize o conector Open-Meteo."
            />
          ) : (
            <div className="divide-y divide-slate-800 rounded-lg border border-slate-800 bg-[#111827]">
              {connectors.map((c) => (
                <div key={c.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-sm font-semibold text-slate-100">{c.name}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono text-slate-400">{c.connector_type}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={`font-mono font-medium ${
                          c.status === 'HEALTHY'
                            ? 'text-emerald-400'
                            : c.status === 'ERROR'
                              ? 'text-red-400'
                              : 'text-amber-400'
                        }`}
                      >
                        {c.status}
                      </span>
                    </div>
                    <div className="font-mono text-[11px] text-slate-400">
                      Última sincronização: {c.last_sync_at_utc ?? 'nunca'} · Credenciais:{' '}
                      {c.has_credentials ? 'configuradas (cifradas)' : 'nenhuma'}
                    </div>
                    {c.last_error && <div className="text-xs text-red-300">{c.last_error}</div>}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busyId === c.id}
                      onClick={() => void handleTest(c.id)}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <PlugZap className="h-3.5 w-3.5" aria-hidden="true" />
                      Testar
                    </button>
                    <button
                      type="button"
                      disabled={busyId === c.id}
                      onClick={() => void handleSync(c.id)}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      Sincronizar
                    </button>
                    <button
                      type="button"
                      onClick={() => setIngestConnectorId(c.id)}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                      Ingerir
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void apiRequest(`/api/integrations/connectors/${c.id}`, { method: 'DELETE' }).then(() => loadAll())
                      }
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-red-400"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {ingestConnectorId && (
            <form onSubmit={handleManualIngest} className="space-y-3 rounded-lg border border-blue-500/40 bg-[#111827] p-4">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold text-slate-100">Ingestão Autenticada de Evento Real (Contrato Canônico)</h4>
                <button type="button" onClick={() => setIngestConnectorId(null)} className="text-xs text-slate-400 hover:text-slate-200">
                  Fechar
                </button>
              </div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-4">
                <select
                  value={ingestSiteId}
                  onChange={(e) => setIngestSiteId(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="">Site (opcional)</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </select>
                <input
                  required
                  placeholder="Origem (ex: ups_field)"
                  value={ingestSource}
                  onChange={(e) => setIngestSource(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                />
                <select
                  value={ingestEventType}
                  onChange={(e) => setIngestEventType(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value="power_outage">power_outage</option>
                  <option value="link_down">link_down</option>
                  <option value="ups_battery">ups_battery</option>
                  <option value="weather_alert">weather_alert</option>
                </select>
                <select
                  value={ingestStatus}
                  onChange={(e) => setIngestStatus(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                >
                  <option value="DOWN">DOWN</option>
                  <option value="OUTAGE">OUTAGE</option>
                  <option value="DEGRADED">DEGRADED</option>
                  <option value="UP">UP</option>
                </select>
              </div>
              <button type="submit" className="rounded bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
                Registrar Evento Idempotente
              </button>
            </form>
          )}

          {/* Histórico de Execuções */}
          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
            <div className="border-b border-slate-800 px-4 py-3 text-xs font-semibold text-slate-200">
              Histórico de Sincronizações
            </div>
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-4 py-2.5 font-medium">Início (UTC)</th>
                  <th className="px-4 py-2.5 font-medium">Conector</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 text-right font-medium">Ingeridos / Dedup</th>
                  <th className="px-4 py-2.5 text-right font-medium">Latência</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {runs.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      Nenhuma execução registrada ainda.
                    </td>
                  </tr>
                ) : (
                  runs.map((r) => (
                    <tr key={r.id}>
                      <td className="px-4 py-2.5 font-mono text-[11px] text-slate-300">{r.started_at_utc}</td>
                      <td className="px-4 py-2.5 text-slate-200">{r.connector_name}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px]">
                        <span className={r.status === 'SUCCESS' ? 'text-emerald-400' : 'text-red-400'}>{r.status}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-300">
                        {r.records_ingested} / {r.records_deduplicated}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-400">
                        {r.latency_ms !== null ? `${r.latency_ms} ms` : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
