import { useEffect, useState, type FormEvent } from 'react';
import { GitBranch, Globe, Search, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type {
  Asset,
  AssetCategory,
  Concession,
  Criticality,
  LocalityType,
  Site,
  TopologyEdge,
} from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface InventoryTopologyViewProps {
  activeTenantId: string | null;
}

type SubTab = 'sites' | 'assets' | 'topology' | 'taxonomies';

export function InventoryTopologyView({ activeTenantId }: InventoryTopologyViewProps) {
  const [subTab, setSubTab] = useState<SubTab>('sites');
  const [sites, setSites] = useState<Site[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [sharedDeps, setSharedDeps] = useState<Array<{ upstream_asset_id: string; downstream_count: number }>>([]);
  const [concessions, setConcessions] = useState<Concession[]>([]);
  const [localityTypes, setLocalityTypes] = useState<LocalityType[]>([]);
  const [categories, setCategories] = useState<AssetCategory[]>([]);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; msg: string } | null>(null);

  // Form Sites
  const [siteCode, setSiteCode] = useState('');
  const [siteName, setSiteName] = useState('');
  const [siteCep, setSiteCep] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteMunicipality, setSiteMunicipality] = useState('');
  const [siteUf, setSiteUf] = useState('');
  const [siteLat, setSiteLat] = useState('');
  const [siteLon, setSiteLon] = useState('');
  const [sitePrecision, setSitePrecision] = useState<'manual_verificada' | 'geocodificada'>('manual_verificada');
  const [siteVerified, setSiteVerified] = useState(false);
  const [siteConcessionId, setSiteConcessionId] = useState('');
  const [siteLocalityTypeId, setSiteLocalityTypeId] = useState('');
  const [siteCriticality, setSiteCriticality] = useState<Criticality>('media');
  const [cepLoading, setCepLoading] = useState(false);

  // Form Assets
  const [assetSiteId, setAssetSiteId] = useState('');
  const [assetCategoryId, setAssetCategoryId] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetHost, setAssetHost] = useState('');
  const [assetIp, setAssetIp] = useState('');
  const [assetProvider, setAssetProvider] = useState('');
  const [assetCriticality, setAssetCriticality] = useState<Criticality>('media');

  // Form Topology Edge
  const [edgeSourceId, setEdgeSourceId] = useState('');
  const [edgeTargetId, setEdgeTargetId] = useState('');
  const [edgeType, setEdgeType] = useState('uplink_fibra');
  const [edgeProvider, setEdgeProvider] = useState('');
  const [edgeCapacity, setEdgeCapacity] = useState('');
  const [edgeRedundant, setEdgeRedundant] = useState(false);

  // Form Concessões / Tipos
  const [concName, setConcName] = useState('');
  const [concCode, setConcCode] = useState('');
  const [concRegion, setConcRegion] = useState('');
  const [locCode, setLocCode] = useState('');
  const [locLabel, setLocLabel] = useState('');

  async function loadAll() {
    if (!activeTenantId) return;
    const [sRes, aRes, tRes, cRes, lRes, catRes] = await Promise.all([
      apiRequest<{ sites: Site[] }>('/api/sites'),
      apiRequest<{ assets: Asset[] }>('/api/assets'),
      apiRequest<{ edges: TopologyEdge[]; shared_upstream_dependencies: Array<{ upstream_asset_id: string; downstream_count: number }> }>('/api/topology/edges'),
      apiRequest<{ concessions: Concession[] }>('/api/concessions'),
      apiRequest<{ locality_types: LocalityType[] }>('/api/locality-types'),
      apiRequest<{ asset_categories: AssetCategory[] }>('/api/asset-categories'),
    ]);
    setSites(sRes.sites);
    setAssets(aRes.assets);
    setEdges(tRes.edges);
    setSharedDeps(tRes.shared_upstream_dependencies);
    setConcessions(cRes.concessions);
    setLocalityTypes(lRes.locality_types);
    setCategories(catRes.asset_categories);
  }

  useEffect(() => {
    void loadAll();
  }, [activeTenantId]);

  async function handleLookupCep() {
    setFeedback(null);
    setCepLoading(true);
    try {
      const res = await apiRequest<{
        cep: string;
        address: string;
        municipality: string;
        uf: string;
        source: string;
        coordinates_note: string;
      }>(`/api/geo/cep/${encodeURIComponent(siteCep)}`);
      setSiteAddress(res.address);
      setSiteMunicipality(res.municipality);
      setSiteUf(res.uf);
      setFeedback({ type: 'ok', msg: `Endereço obtido via ${res.source}. ${res.coordinates_note}` });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao consultar CEP.' });
    } finally {
      setCepLoading(false);
    }
  }

  async function handleGeocode() {
    setFeedback(null);
    setCepLoading(true);
    try {
      const res = await apiRequest<{ latitude: number; longitude: number; display_name: string }>('/api/geo/geocode', {
        method: 'POST',
        body: JSON.stringify({ address: siteAddress, municipality: siteMunicipality, uf: siteUf }),
      });
      setSiteLat(res.latitude.toFixed(6));
      setSiteLon(res.longitude.toFixed(6));
      setSitePrecision('geocodificada');
      setFeedback({
        type: 'ok',
        msg: `Coordenadas geocodificadas (${res.display_name}). Revise no mapa e marque como verificada se estiver exata.`,
      });
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Falha na geocodificação.' });
    } finally {
      setCepLoading(false);
    }
  }

  async function handleCreateSite(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/sites', {
        method: 'POST',
        body: JSON.stringify({
          code: siteCode,
          name: siteName,
          cep: siteCep || undefined,
          address: siteAddress || undefined,
          municipality: siteMunicipality || undefined,
          uf: siteUf || undefined,
          latitude: siteLat ? Number(siteLat) : undefined,
          longitude: siteLon ? Number(siteLon) : undefined,
          coord_precision: siteLat && siteLon ? sitePrecision : 'pendente',
          coord_verified: siteLat && siteLon ? siteVerified : false,
          concession_id: siteConcessionId || undefined,
          locality_type_id: siteLocalityTypeId || undefined,
          criticality: siteCriticality,
        }),
      });
      setSiteCode('');
      setSiteName('');
      setSiteCep('');
      setSiteAddress('');
      setSiteMunicipality('');
      setSiteUf('');
      setSiteLat('');
      setSiteLon('');
      setSiteVerified(false);
      setFeedback({ type: 'ok', msg: 'Site cadastrado com sucesso.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao cadastrar site.' });
    }
  }

  async function handleCreateAsset(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/assets', {
        method: 'POST',
        body: JSON.stringify({
          site_id: assetSiteId,
          category_id: assetCategoryId || undefined,
          name: assetName,
          hostname: assetHost || undefined,
          ip_address: assetIp || undefined,
          provider_name: assetProvider || undefined,
          criticality: assetCriticality,
        }),
      });
      setAssetName('');
      setAssetHost('');
      setAssetIp('');
      setAssetProvider('');
      setFeedback({ type: 'ok', msg: 'Ativo cadastrado (estado inicial: NO_DATA).' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao cadastrar ativo.' });
    }
  }

  async function handleCreateEdge(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/topology/edges', {
        method: 'POST',
        body: JSON.stringify({
          source_asset_id: edgeSourceId,
          target_asset_id: edgeTargetId,
          link_type: edgeType,
          provider_name: edgeProvider || undefined,
          capacity_mbps: edgeCapacity ? Number(edgeCapacity) : undefined,
          is_redundant: edgeRedundant,
        }),
      });
      setEdgeProvider('');
      setEdgeCapacity('');
      setFeedback({ type: 'ok', msg: 'Enlace topológico validado (sem ciclos) e registrado.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao criar enlace.' });
    }
  }

  async function handleCreateConcession(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/concessions', {
        method: 'POST',
        body: JSON.stringify({ name: concName, code: concCode, region: concRegion || undefined }),
      });
      setConcName('');
      setConcCode('');
      setConcRegion('');
      setFeedback({ type: 'ok', msg: 'Concessão/Unidade cadastrada.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao criar concessão.' });
    }
  }

  async function handleCreateLocalityType(e: FormEvent) {
    e.preventDefault();
    setFeedback(null);
    try {
      await apiRequest('/api/locality-types', {
        method: 'POST',
        body: JSON.stringify({ code: locCode, label: locLabel }),
      });
      setLocCode('');
      setLocLabel('');
      setFeedback({ type: 'ok', msg: 'Tipo de localidade customizado adicionado.' });
      await loadAll();
    } catch (err) {
      setFeedback({ type: 'err', msg: err instanceof Error ? err.message : 'Erro ao criar tipo.' });
    }
  }

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Selecione um tenant para gerenciar cadastros"
        description="Sites, ativos, topologia e taxonomias são isolados por tenant."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Cadastros e Topologia</h2>
          <p className="text-sm text-slate-400">
            Sites com busca de endereço por CEP, ativos monitoráveis e grafo direcionado topology_edges com prevenção de ciclos.
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#111827] p-1">
          {(
            [
              { id: 'sites', label: `Sites (${sites.length})` },
              { id: 'assets', label: `Ativos (${assets.length})` },
              { id: 'topology', label: `Topologia (${edges.length})` },
              { id: 'taxonomies', label: 'Concessões e Tipos' },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className={`whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                subTab === t.id ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
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

      {subTab === 'sites' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <form onSubmit={handleCreateSite} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-slate-100">Novo Site / Localidade</h3>
            <div className="grid grid-cols-2 gap-2.5">
              <input
                required
                placeholder="Código (ex: ETA-01)"
                value={siteCode}
                onChange={(e) => setSiteCode(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <select
                value={siteCriticality}
                onChange={(e) => setSiteCriticality(e.target.value as Criticality)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              >
                <option value="critica">Criticidade: Crítica</option>
                <option value="alta">Criticidade: Alta</option>
                <option value="media">Criticidade: Média</option>
                <option value="baixa">Criticidade: Baixa</option>
              </select>
            </div>
            <input
              required
              placeholder="Nome completo do site"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            />
            <div className="grid grid-cols-2 gap-2.5">
              <select
                value={siteConcessionId}
                onChange={(e) => setSiteConcessionId(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              >
                <option value="">Concessão (opcional)</option>
                {concessions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </select>
              <select
                value={siteLocalityTypeId}
                onChange={(e) => setSiteLocalityTypeId(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              >
                <option value="">Tipo de localidade</option>
                {localityTypes.map((lt) => (
                  <option key={lt.id} value={lt.id}>
                    {lt.code} — {lt.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-2">
              <input
                placeholder="CEP (8 dígitos)"
                value={siteCep}
                onChange={(e) => setSiteCep(e.target.value)}
                className="flex-1 rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <button
                type="button"
                disabled={cepLoading || !siteCep}
                onClick={() => void handleLookupCep()}
                className="inline-flex items-center gap-1 rounded border border-slate-700 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
              >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
                Buscar CEP
              </button>
            </div>

            <input
              placeholder="Logradouro / Endereço"
              value={siteAddress}
              onChange={(e) => setSiteAddress(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            />
            <div className="grid grid-cols-3 gap-2">
              <input
                placeholder="Município"
                value={siteMunicipality}
                onChange={(e) => setSiteMunicipality(e.target.value)}
                className="col-span-2 rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              />
              <input
                placeholder="UF"
                maxLength={2}
                value={siteUf}
                onChange={(e) => setSiteUf(e.target.value.toUpperCase())}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-xs text-slate-400">Coordenadas (não inventadas por CEP)</span>
              <button
                type="button"
                disabled={cepLoading || !siteMunicipality || !siteUf}
                onClick={() => void handleGeocode()}
                className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50"
              >
                <Globe className="h-3.5 w-3.5" aria-hidden="true" />
                Geocodificar
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <input
                type="number"
                step="any"
                placeholder="Latitude"
                value={siteLat}
                onChange={(e) => setSiteLat(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <input
                type="number"
                step="any"
                placeholder="Longitude"
                value={siteLon}
                onChange={(e) => setSiteLon(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>

            {siteLat && siteLon && (
              <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  checked={siteVerified}
                  onChange={(e) => setSiteVerified(e.target.checked)}
                  className="rounded border-slate-600 bg-slate-900 text-blue-600"
                />
                Coordenadas validadas manualmente (habilita marcador no mapa)
              </label>
            )}

            <button
              type="submit"
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500"
            >
              Salvar Site
            </button>
          </form>

          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827] lg:col-span-2">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-4 py-3 font-medium">Código / Site</th>
                  <th className="px-4 py-3 font-medium">Tipo / Concessão</th>
                  <th className="px-4 py-3 font-medium">Localização</th>
                  <th className="px-4 py-3 font-medium">Coordenadas</th>
                  <th className="px-4 py-3 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {sites.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                      Nenhum site cadastrado neste tenant.
                    </td>
                  </tr>
                ) : (
                  sites.map((s) => (
                    <tr key={s.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-100">{s.name}</div>
                        <div className="font-mono text-[11px] text-slate-400">
                          {s.code} · {s.criticality}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        <div>{s.locality_type_code ?? '—'}</div>
                        <div className="text-[11px] text-slate-400">{s.concession_name ?? 'Sem concessão'}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        <div>
                          {s.municipality ?? '—'}/{s.uf ?? '—'}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{s.cep ?? 'Sem CEP'}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        {s.latitude !== null && s.longitude !== null ? (
                          <div>
                            <span className={s.coord_verified ? 'text-emerald-400' : 'text-amber-400'}>
                              {s.coord_verified ? 'VERIFICADA' : 'NÃO VERIFICADA'}
                            </span>
                            <div className="text-slate-400 tabular-nums">
                              {s.latitude.toFixed(4)}, {s.longitude.toFixed(4)}
                            </div>
                          </div>
                        ) : (
                          <span className="text-amber-400">PENDENTE</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          title="Excluir site"
                          onClick={() =>
                            void apiRequest(`/api/sites/${s.id}`, { method: 'DELETE' }).then(() => loadAll())
                          }
                          className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'assets' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <form onSubmit={handleCreateAsset} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-slate-100">Novo Ativo de Infraestrutura</h3>
            <select
              required
              value={assetSiteId}
              onChange={(e) => setAssetSiteId(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="">Selecione o Site</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.code} — {s.name}
                </option>
              ))}
            </select>
            <select
              value={assetCategoryId}
              onChange={(e) => setAssetCategoryId(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="">Categoria (opcional)</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.domain} · {c.label}
                </option>
              ))}
            </select>
            <input
              required
              placeholder="Nome do ativo (ex: RTR-CORE-01)"
              value={assetName}
              onChange={(e) => setAssetName(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            />
            <div className="grid grid-cols-2 gap-2.5">
              <input
                placeholder="Hostname"
                value={assetHost}
                onChange={(e) => setAssetHost(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <input
                placeholder="IP de gerência"
                value={assetIp}
                onChange={(e) => setAssetIp(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <input
                placeholder="Operadora / Provedor"
                value={assetProvider}
                onChange={(e) => setAssetProvider(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              />
              <select
                value={assetCriticality}
                onChange={(e) => setAssetCriticality(e.target.value as Criticality)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              >
                <option value="critica">Crítica</option>
                <option value="alta">Alta</option>
                <option value="media">Média</option>
                <option value="baixa">Baixa</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={sites.length === 0}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Cadastrar Ativo
            </button>
          </form>

          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827] lg:col-span-2">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="px-4 py-3 font-medium">Ativo</th>
                  <th className="px-4 py-3 font-medium">Site</th>
                  <th className="px-4 py-3 font-medium">Categoria / Provedor</th>
                  <th className="px-4 py-3 font-medium">Estado Telemetria</th>
                  <th className="px-4 py-3 text-right font-medium">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {assets.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-slate-500">
                      Nenhum ativo cadastrado.
                    </td>
                  </tr>
                ) : (
                  assets.map((a) => (
                    <tr key={a.id} className="hover:bg-slate-800/30">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-100">{a.name}</div>
                        <div className="font-mono text-[11px] text-slate-400">
                          {a.hostname ?? '—'} · {a.ip_address ?? 'sem IP'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        <span className="font-mono text-[11px] text-slate-400">{a.site_code}</span> · {a.site_name}
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        <div>{a.category_label ?? '—'}</div>
                        <div className="text-[11px] text-slate-400">{a.provider_name ?? '—'}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px]">
                        <span
                          className={
                            a.operational_state === 'UP'
                              ? 'text-emerald-400'
                              : a.operational_state === 'DOWN'
                                ? 'text-red-400'
                                : a.operational_state === 'DEGRADED'
                                  ? 'text-amber-400'
                                  : 'text-slate-400'
                          }
                        >
                          {a.operational_state}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            void apiRequest(`/api/assets/${a.id}`, { method: 'DELETE' }).then(() => loadAll())
                          }
                          className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-red-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'topology' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <form onSubmit={handleCreateEdge} className="space-y-3 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
              <GitBranch className="h-4 w-4 text-blue-400" aria-hidden="true" />
              Novo Enlace (topology_edges)
            </div>
            <p className="text-xs text-slate-400">
              Ciclos direcionados são bloqueados no servidor para manter o grafo causal consistente.
            </p>
            <select
              required
              value={edgeSourceId}
              onChange={(e) => setEdgeSourceId(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="">Origem Upstream (Pai)</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.site_code} · {a.name}
                </option>
              ))}
            </select>
            <select
              required
              value={edgeTargetId}
              onChange={(e) => setEdgeTargetId(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            >
              <option value="">Destino Downstream (Filho)</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.site_code} · {a.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-2.5">
              <input
                required
                placeholder="Tipo (uplink_fibra, radio)"
                value={edgeType}
                onChange={(e) => setEdgeType(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
              <input
                type="number"
                placeholder="Mbps"
                value={edgeCapacity}
                onChange={(e) => setEdgeCapacity(e.target.value)}
                className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
              />
            </div>
            <input
              placeholder="Provedor / Operadora"
              value={edgeProvider}
              onChange={(e) => setEdgeProvider(e.target.value)}
              className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
            />
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={edgeRedundant}
                onChange={(e) => setEdgeRedundant(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-blue-600"
              />
              Enlace redundante (backup)
            </label>
            <button
              type="submit"
              disabled={assets.length < 2}
              className="w-full rounded-md bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              Adicionar Enlace
            </button>
          </form>

          <div className="space-y-4 lg:col-span-2">
            {sharedDeps.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-[#111827] p-4 text-xs text-slate-300">
                <div className="font-semibold text-amber-300">Dependências Upstream Compartilhadas Detectadas</div>
                <div className="mt-1 space-y-1">
                  {sharedDeps.map((d) => {
                    const asset = assets.find((a) => a.id === d.upstream_asset_id);
                    return (
                      <div key={d.upstream_asset_id} className="font-mono">
                        {asset ? `${asset.site_code} · ${asset.name}` : d.upstream_asset_id} →{' '}
                        <span className="tabular-nums text-amber-300">{d.downstream_count} ativos dependentes</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="overflow-x-auto rounded-lg border border-slate-800 bg-[#111827]">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400">
                    <th className="px-4 py-3 font-medium">Upstream (Origem)</th>
                    <th className="px-4 py-3 font-medium">Downstream (Destino)</th>
                    <th className="px-4 py-3 font-medium">Enlace / Provedor</th>
                    <th className="px-4 py-3 text-right font-medium">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {edges.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-10 text-center text-slate-500">
                        Nenhum enlace cadastrado na topologia.
                      </td>
                    </tr>
                  ) : (
                    edges.map((e) => (
                      <tr key={e.id} className="hover:bg-slate-800/30">
                        <td className="px-4 py-3 font-medium text-slate-100">{e.source_asset_name}</td>
                        <td className="px-4 py-3 font-medium text-slate-200">{e.target_asset_name}</td>
                        <td className="px-4 py-3 text-slate-300">
                          <div className="font-mono text-[11px]">
                            {e.link_type} {e.is_redundant ? '· redundante' : '· primário'}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {e.provider_name ?? '—'} {e.capacity_mbps ? `· ${e.capacity_mbps} Mbps` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() =>
                              void apiRequest(`/api/topology/edges/${e.id}`, { method: 'DELETE' }).then(() => loadAll())
                            }
                            className="rounded p-1.5 text-slate-400 hover:bg-slate-800 hover:text-red-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
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

      {subTab === 'taxonomies' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-4 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-slate-100">Concessões / Unidades de Negócio</h3>
            <div className="divide-y divide-slate-800/80">
              {concessions.length === 0 ? (
                <div className="py-3 text-xs text-slate-500">Nenhuma concessão cadastrada ainda.</div>
              ) : (
                concessions.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-2.5 text-xs">
                    <div>
                      <span className="font-mono text-slate-300">{c.code}</span> ·{' '}
                      <span className="font-medium text-slate-100">{c.name}</span>
                      {c.region && <span className="text-slate-400"> ({c.region})</span>}
                    </div>
                  </div>
                ))
              )}
            </div>
            <form onSubmit={handleCreateConcession} className="space-y-2.5 border-t border-slate-800 pt-3">
              <div className="grid grid-cols-2 gap-2">
                <input
                  required
                  placeholder="Código (ex: SUL-01)"
                  value={concCode}
                  onChange={(e) => setConcCode(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
                />
                <input
                  placeholder="Região (opcional)"
                  value={concRegion}
                  onChange={(e) => setConcRegion(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <input
                required
                placeholder="Nome da concessão ou unidade"
                value={concName}
                onChange={(e) => setConcName(e.target.value)}
                className="w-full rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
              />
              <button type="submit" className="rounded bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
                Adicionar Concessão
              </button>
            </form>
          </div>

          <div className="space-y-4 rounded-lg border border-slate-800 bg-[#111827] p-5">
            <h3 className="text-sm font-semibold text-slate-100">Tipos Customizáveis de Localidade</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {localityTypes.map((lt) => (
                <div key={lt.id} className="rounded border border-slate-800 bg-[#0B111E] px-3 py-2 text-xs">
                  <div className="font-mono font-medium text-slate-200">{lt.code}</div>
                  <div className="text-slate-400">{lt.label}</div>
                </div>
              ))}
            </div>
            <form onSubmit={handleCreateLocalityType} className="space-y-2.5 border-t border-slate-800 pt-3">
              <div className="grid grid-cols-2 gap-2">
                <input
                  required
                  placeholder="Código (ex: RESERVATORIO)"
                  value={locCode}
                  onChange={(e) => setLocCode(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 font-mono text-xs text-slate-100"
                />
                <input
                  required
                  placeholder="Rótulo descritivo"
                  value={locLabel}
                  onChange={(e) => setLocLabel(e.target.value)}
                  className="rounded border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <button type="submit" className="rounded bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-500">
                Adicionar Tipo
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
