import { useEffect, useState, type FormEvent } from 'react';
import { FileSpreadsheet, Play, PlugZap, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type {
  AuthorizedCollectionScope,
  Connector,
  ConnectorSyncRun,
  ConnectorType,
  IngestionCheckpoint,
  Site,
} from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface IntegrationsViewProps {
  activeTenantId: string | null;
}

interface CatalogItem {
  connector_type: string;
  label: string;
  domain: string;
  mode: string;
  availability: 'READY' | 'REQUIRES_CREDENTIALS' | 'PENDING_EXTERNAL_SPEC';
  description: string;
  honest_note: string;
}

export function IntegrationsView({ activeTenantId }: IntegrationsViewProps) {
  const [subTab, setSubTab] = useState<'connectors' | 'native' | 'csv'>('connectors');
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [runs, setRuns] = useState<ConnectorSyncRun[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [scopes, setScopes] = useState<AuthorizedCollectionScope[]>([]);
  const [checkpoints, setCheckpoints] = useState<IngestionCheckpoint[]>([]);

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

  // Coleta Nativa Autorizada (SNMPv3 / MQTT / ICMP / OTLP)
  const [scopeProto, setScopeProto] = useState<'snmp_v3' | 'mqtt' | 'icmp' | 'otlp' | 'http_agent'>('otlp');
  const [scopeTarget, setScopeTarget] = useState('');
  const [scopePort, setScopePort] = useState('');
  const [scopeDesc, setScopeDesc] = useState('');
  const [scopeRate, setScopeRate] = useState('60');

  // CSV Incremental com Checkpoints
  const [csvConnectorId, setCsvConnectorId] = useState('');
  const [csvKind, setCsvKind] = useState<'metrics' | 'events' | 'logs'>('metrics');
  const [csvCursorKey, setCsvCursorKey] = useState('lote_historico_01');
  const [csvText, setCsvText] = useState(
    'metric_name,value_num,unit,observed_at_utc,source\ncpu_usage_pct,42.5,%,2026-11-19T10:00:00Z,csv_export',
  );
  const [csvResume, setCsvResume] = useState(true);

  async function loadAll() {
    if (!activeTenantId) return;
    const [intRes, catRes, siteRes, scopeRes] = await Promise.all([
      apiRequest<{ connectors: Connector[]; sync_runs: ConnectorSyncRun[] }>('/api/integrations/connectors'),
      apiRequest<{ catalog: CatalogItem[] }>('/api/integrations/catalog'),
      apiRequest<{ sites: Site[] }>('/api/sites'),
      apiRequest<{ scopes: AuthorizedCollectionScope[] }>('/api/collection/scopes'),
    ]);
    setConnectors(intRes.connectors);
    setRuns(intRes.sync_runs);
    setCatalog(catRes.catalog);
    setSites(siteRes.sites);
    setScopes(scopeRes.scopes);

    const firstConnId = csvConnectorId || intRes.connectors[0]?.id || '';
    if (firstConnId) {
      if (!csvConnectorId) setCsvConnectorId(firstConnId);
      const cpRes = await apiRequest<{ checkpoints: IngestionCheckpoint[] }>(
        `/api/integrations/connectors/${firstConnId}/checkpoints`,
      );
      setCheckpoints(cpRes.checkpoints);
    } else {
      setCheckpoints([]);
    }
  }

  useEffect(() => {
    void loadAll();
  }, [activeTenantId]);

  async function loadCheckpointsFor(connId: string) {
    setCsvConnectorId(connId);
    if (!connId) {
      setCheckpoints([]);
      return;
    }
    const res = await apiRequest<{ checkpoints: IngestionCheckpoint[] }>(`/api/integrations/connectors/${connId}/checkpoints`);
    setCheckpoints(res.checkpoints);
  }

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

  async function handleCreateScope(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/collection/scopes', {
        method: 'POST',
        body: JSON.stringify({
          protocol: scopeProto,
          target_cidr_or_host: scopeTarget,
          port: scopePort ? Number(scopePort) : undefined,
          description: scopeDesc || undefined,
          rate_limit_rpm: Number(scopeRate || 60),
        }),
      });
      setScopeTarget('');
      setScopePort('');
      setScopeDesc('');
      setFeedback({ type: 'ok', msg: 'Escopo de coleta nativa aprovado e auditado.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao registrar escopo.' });
    }
  }

  async function handleIngestCsv(e: FormEvent) {
    e.preventDefault();
    if (!csvConnectorId) return;
    setFeedback(null);
    try {
      const res = await apiRequest<{
        resumed_from_row: number;
        rows_processed_now: number;
        cumulative_rows_processed: number;
        ingested: number;
        deduplicated: number;
        anomalies_detected: number;
        status: string;
      }>(`/api/integrations/connectors/${csvConnectorId}/ingest-csv`, {
        method: 'POST',
        body: JSON.stringify({
          csv_text: csvText,
          kind: csvKind,
          cursor_key: csvCursorKey,
          resume_from_checkpoint: csvResume,
        }),
      });
      setFeedback({
        type: 'ok',
        msg: `CSV ${res.status}: retomado da linha ${res.resumed_from_row}, ${res.ingested} inserido(s), ${res.deduplicated} deduplicado(s), ${res.anomalies_detected} anomalia(s).`,
      });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro na importação CSV incremental.' });
    }
  }

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Selecione um tenant para gerenciar integrações"
        description="Conectores, escopos de coleta nativa, credenciais e checkpoints CSV são estritamente isolados por tenant."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Integrações Híbridas e Coleta Nativa</h2>
          <p className="text-sm text-slate-400">
            Conectores externos com anti-SSRF, catálogo extensível (SLAview marcado como NOT_CONFIGURED até confirmação de API), coleta nativa autorizada e CSV incremental com checkpoints.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#111827] p-1">
          <button
            type="button"
            onClick={() => setSubTab('connectors')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              subTab === 'connectors' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Conectores ({connectors.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('native')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              subTab === 'native' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Coleta Nativa Autorizada ({scopes.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('csv')}
            className={`rounded px-3 py-1.5 text-xs font-medium ${
              subTab === 'csv' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            CSV Incremental
          </button>
        </div>
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

      {subTab === 'connectors' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <form onSubmit={handleCreateConnector} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-slate-100">Configurar Novo Conector</h3>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ConnectorType)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              {catalog.length > 0 ? (
                catalog.map((item) => (
                  <option key={item.connector_type} value={item.connector_type}>
                    {item.domain.toUpperCase()} · {item.label}
                  </option>
                ))
              ) : (
                <>
                  <option value="open_meteo">AMBIENTE · Open-Meteo</option>
                  <option value="zabbix">TI · Zabbix API</option>
                  <option value="slaview">REDE · Telcomanager SLAview</option>
                  <option value="webhook_csv">TI · Webhook / CSV</option>
                </>
              )}
            </select>

            {type === 'slaview' && (
              <div className="rounded border border-amber-500/40 bg-amber-950/20 p-2.5 text-[11px] text-amber-200">
                Dependência pendente: SLAview permanece <span className="font-mono">NOT_CONFIGURED</span> até confirmação oficial de URL, versão da API e autenticação.
              </div>
            )}

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
                description="Adicione um conector ao lado. Para testar ingestão climática real imediatamente após cadastrar sites com coordenadas verificadas, utilize Open-Meteo; para eventos/CSV, utilize Webhook/CSV."
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
                    <option value="app_latency_critical">app_latency_critical</option>
                    <option value="iot_sensor_offline">iot_sensor_offline</option>
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
      )}

      {subTab === 'native' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <form onSubmit={handleCreateScope} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Aprovar Escopo de Coleta Nativa
            </div>
            <p className="text-xs text-slate-400">
              Política anti-varredura: coletores SNMPv3, MQTT, ICMP e receptores OTLP só aceitam alvos cadastrados e ativos neste tenant.
            </p>
            <select
              value={scopeProto}
              onChange={(e) => setScopeProto(e.target.value as AuthorizedCollectionScope['protocol'])}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="otlp">OpenTelemetry / OTLP</option>
              <option value="snmp_v3">SNMPv3 (authPriv)</option>
              <option value="mqtt">MQTT / TLS (IoT)</option>
              <option value="icmp">ICMP Probe</option>
              <option value="http_agent">Agente HTTP Interno</option>
            </select>
            <input
              required
              placeholder="CIDR ou Host (ex: 10.20.0.0/24 ou api-pagamentos)"
              value={scopeTarget}
              onChange={(e) => setScopeTarget(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
            />
            <div className="grid grid-cols-2 gap-2.5">
              <input
                type="number"
                placeholder="Porta (opcional)"
                value={scopePort}
                onChange={(e) => setScopePort(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <input
                type="number"
                min={1}
                max={600}
                placeholder="Limite RPM"
                value={scopeRate}
                onChange={(e) => setScopeRate(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>
            <input
              placeholder="Descrição / Justificativa operacional"
              value={scopeDesc}
              onChange={(e) => setScopeDesc(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            />
            <button type="submit" className="w-full rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500">
              Aprovar Escopo Autorizado
            </button>
          </form>

          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827] lg:col-span-2">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-4 py-3 font-medium">Protocolo</th>
                  <th className="px-4 py-3 font-medium">Alvo / CIDR Autorizado</th>
                  <th className="px-4 py-3 font-medium">Limite</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {scopes.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                      Nenhum escopo autorizado aprovado. Todas as coletas nativas/OTLP permanecem bloqueadas (403).
                    </td>
                  </tr>
                ) : (
                  scopes.map((sc) => (
                    <tr key={sc.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3 font-mono text-slate-200">{sc.protocol}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-slate-100">
                          {sc.target_cidr_or_host}
                          {sc.port ? `:${sc.port}` : ''}
                        </div>
                        {sc.description && <div className="text-[11px] text-slate-400">{sc.description}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-300">{sc.rate_limit_rpm} rpm</td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span className={sc.is_active ? 'text-emerald-400' : 'text-amber-400'}>
                          {sc.is_active ? 'ATIVO' : 'SUSPENSO'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              void apiRequest(`/api/collection/scopes/${sc.id}/toggle`, { method: 'PATCH' }).then(() => loadAll())
                            }
                            className="rounded border border-slate-700 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                          >
                            {sc.is_active ? 'Suspender' : 'Reativar'}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void apiRequest(`/api/collection/scopes/${sc.id}`, { method: 'DELETE' }).then(() => loadAll())
                            }
                            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'csv' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <form onSubmit={handleIngestCsv} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5 lg:col-span-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <FileSpreadsheet className="h-4 w-4 text-blue-400" aria-hidden="true" />
              Importação CSV Incremental com Checkpoints
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
              <select
                required
                value={csvConnectorId}
                onChange={(e) => void loadCheckpointsFor(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              >
                <option value="">Selecione o Conector</option>
                {connectors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.connector_type})
                  </option>
                ))}
              </select>
              <select
                value={csvKind}
                onChange={(e) => setCsvKind(e.target.value as 'metrics' | 'events' | 'logs')}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              >
                <option value="metrics">Métricas (metric_samples)</option>
                <option value="events">Eventos (canonical_events)</option>
                <option value="logs">Logs (operational_logs)</option>
              </select>
              <input
                required
                placeholder="Cursor Key (ex: historico_2026)"
                value={csvCursorKey}
                onChange={(e) => setCsvCursorKey(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>

            <textarea
              rows={7}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] p-3 font-mono text-xs text-slate-100"
            />

            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={csvResume}
                onChange={(e) => setCsvResume(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-blue-600"
              />
              Retomar a partir do último checkpoint salvo (`rows_processed`)
            </label>

            <button
              type="submit"
              disabled={!csvConnectorId}
              className="rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Processar Lote CSV com Checkpoint
            </button>
          </form>

          <div className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-slate-100">Checkpoints Persistidos</h3>
            {checkpoints.length === 0 ? (
              <div className="text-xs text-slate-500">Nenhum checkpoint registrado para o conector selecionado.</div>
            ) : (
              <div className="space-y-2">
                {checkpoints.map((cp) => (
                  <div key={cp.id} className="rounded border border-slate-800 bg-[#0B111E] p-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-medium text-slate-100">{cp.cursor_key}</span>
                      <span className="font-mono text-[11px] text-emerald-400">{cp.status}</span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                      Linhas processadas: {cp.rows_processed} · {cp.bytes_processed} bytes
                    </div>
                    <div className="mt-0.5 font-mono text-[10px] text-slate-500">{cp.updated_at_utc}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
