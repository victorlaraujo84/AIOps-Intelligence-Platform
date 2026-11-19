import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Check, Layers, MapPin } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import type { CanonicalEvent, Concession, Site, TopologyEdge } from '../shared/types.ts';
import { HonestStateBanner } from './HonestStateBanner.tsx';

interface OperationalMapViewProps {
  activeTenantId: string | null;
  onNavigate: (tab: string) => void;
}

type BaseLayerKey = 'dark_matter' | 'osm' | 'esri_satellite';

const TILE_LAYERS: Record<BaseLayerKey, { label: string; url: string; attribution: string }> = {
  dark_matter: {
    label: 'CartoDB Dark Matter',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap &copy; CARTO',
  },
  osm: {
    label: 'OpenStreetMap',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
  },
  esri_satellite: {
    label: 'Esri Satélite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
};

export function OperationalMapView({ activeTenantId, onNavigate }: OperationalMapViewProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const overlayGroupRef = useRef<L.LayerGroup | null>(null);

  const [sites, setSites] = useState<Site[]>([]);
  const [concessions, setConcessions] = useState<Concession[]>([]);
  const [edges, setEdges] = useState<TopologyEdge[]>([]);
  const [weatherEvents, setWeatherEvents] = useState<CanonicalEvent[]>([]);
  const [baseLayer, setBaseLayer] = useState<BaseLayerKey>('dark_matter');
  const [concessionFilter, setConcessionFilter] = useState<string>('ALL');
  const [showEdges, setShowEdges] = useState<boolean>(true);
  const [showWeather, setShowWeather] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);

  // Edição rápida de coordenadas pendentes
  const [editingSiteId, setEditingSiteId] = useState<string | null>(null);
  const [manualLat, setManualLat] = useState('');
  const [manualLon, setManualLon] = useState('');
  const [coordFeedback, setCoordFeedback] = useState<string | null>(null);

  async function loadMapData() {
    if (!activeTenantId) return;
    setLoading(true);
    try {
      const [sitesRes, concRes, edgesRes, eventsRes] = await Promise.all([
        apiRequest<{ sites: Site[] }>('/api/sites'),
        apiRequest<{ concessions: Concession[] }>('/api/concessions'),
        apiRequest<{ edges: TopologyEdge[] }>('/api/topology/edges'),
        apiRequest<{ events: CanonicalEvent[] }>('/api/events'),
      ]);
      setSites(sitesRes.sites);
      setConcessions(concRes.concessions);
      setEdges(edgesRes.edges);
      setWeatherEvents(eventsRes.events.filter((e) => e.event_type === 'weather_observation'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadMapData();
  }, [activeTenantId]);

  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [-15.793889, -47.882778], // Centro Brasil até haver sites verificados
      zoom: 4,
      zoomControl: true,
    });

    const layerCfg = TILE_LAYERS[baseLayer];
    tileLayerRef.current = L.tileLayer(layerCfg.url, {
      attribution: layerCfg.attribution,
      maxZoom: 19,
    }).addTo(map);

    overlayGroupRef.current = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;

    return () => {
      map.remove();
      mapInstanceRef.current = null;
      tileLayerRef.current = null;
      overlayGroupRef.current = null;
    };
  }, []);

  // Troca de camada base
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    const cfg = TILE_LAYERS[baseLayer];
    tileLayerRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution,
      maxZoom: 19,
    }).addTo(map);
  }, [baseLayer]);

  // Renderização exclusiva de sites verificados
  useEffect(() => {
    const map = mapInstanceRef.current;
    const group = overlayGroupRef.current;
    if (!map || !group) return;

    group.clearLayers();

    const filteredSites = sites.filter(
      (s) =>
        s.coord_verified &&
        s.latitude !== null &&
        s.longitude !== null &&
        (concessionFilter === 'ALL' || s.concession_id === concessionFilter),
    );

    const latestWeatherBySite = new Map<string, CanonicalEvent>();
    for (const ev of weatherEvents) {
      if (ev.site_id && !latestWeatherBySite.has(ev.site_id)) {
        latestWeatherBySite.set(ev.site_id, ev);
      }
    }

    const siteCoordMap = new Map<string, [number, number]>();
    const bounds: L.LatLngExpression[] = [];

    for (const site of filteredSites) {
      const coords: [number, number] = [site.latitude!, site.longitude!];
      siteCoordMap.set(site.id, coords);
      bounds.push(coords);

      const weather = showWeather ? latestWeatherBySite.get(site.id) : undefined;
      const color =
        site.criticality === 'critica'
          ? '#DC2626'
          : site.criticality === 'alta'
            ? '#D97706'
            : '#2563EB';

      const marker = L.circleMarker(coords, {
        radius: 8,
        fillColor: color,
        color: '#F8FAFC',
        weight: 2,
        opacity: 1,
        fillOpacity: 0.9,
      });

      const weatherHtml = weather
        ? `<div style="margin-top:6px;padding-top:6px;border-top:1px solid rgba(148,163,184,0.2);font-size:11px;">
             <strong>Clima (${weather.source}):</strong><br/>
             Temp: ${String((weather.payload_json as Record<string, unknown>).temperature_2m ?? '—')} °C ·
             Chuva: ${String((weather.payload_json as Record<string, unknown>).precipitation ?? '—')} mm ·
             Rajada: ${String((weather.payload_json as Record<string, unknown>).wind_gusts_10m ?? '—')} km/h<br/>
             <span style="color:#94A3B8">Obs UTC: ${weather.observed_at_utc}</span>
           </div>`
        : `<div style="margin-top:6px;font-size:11px;color:#94A3B8;">Telemetria climática: NO_DATA</div>`;

      marker.bindPopup(`
        <div style="min-width:210px;font-size:12px;line-height:1.45">
          <div style="font-weight:600;color:#F8FAFC">${site.code} — ${site.name}</div>
          <div style="color:#94A3B8;margin-top:2px">${site.municipality ?? '—'}/${site.uf ?? '—'} · Criticidade: ${site.criticality}</div>
          <div style="font-family:monospace;font-size:11px;color:#CBD5E1;margin-top:4px">
            ${site.latitude!.toFixed(5)}, ${site.longitude!.toFixed(5)} (${site.coord_precision})
          </div>
          ${weatherHtml}
        </div>
      `);

      marker.addTo(group);
    }

    if (showEdges) {
      for (const edge of edges) {
        if (!edge.source_site_id || !edge.target_site_id || edge.source_site_id === edge.target_site_id) continue;
        const from = siteCoordMap.get(edge.source_site_id);
        const to = siteCoordMap.get(edge.target_site_id);
        if (!from || !to) continue;

        L.polyline([from, to], {
          color: edge.is_redundant ? '#16A34A' : '#3B82F6',
          weight: 2,
          opacity: 0.7,
          dashArray: edge.is_redundant ? '4 4' : undefined,
        })
          .bindTooltip(`${edge.source_asset_name ?? 'Upstream'} → ${edge.target_asset_name ?? 'Downstream'} (${edge.link_type})`)
          .addTo(group);
      }
    }

    if (bounds.length > 0) {
      map.fitBounds(bounds as L.LatLngBoundsExpression, { padding: [40, 40], maxZoom: 13 });
    }
  }, [sites, edges, weatherEvents, concessionFilter, showEdges, showWeather]);

  async function handleVerifySiteCoords(siteId: string) {
    setCoordFeedback(null);
    try {
      await apiRequest(`/api/sites/${siteId}/verify-coords`, {
        method: 'PATCH',
        body: JSON.stringify({ latitude: Number(manualLat), longitude: Number(manualLon) }),
      });
      setEditingSiteId(null);
      setManualLat('');
      setManualLon('');
      setCoordFeedback('Coordenadas verificadas e publicadas no mapa operacional.');
      await loadMapData();
    } catch (err) {
      setCoordFeedback(err instanceof Error ? err.message : 'Erro ao validar coordenadas.');
    }
  }

  if (!activeTenantId) {
    return (
      <HonestStateBanner
        state="NOT_CONFIGURED"
        title="Mapa indisponível sem tenant ativo"
        description="Selecione um tenant para visualizar os sites georreferenciados verificados."
      />
    );
  }

  const verifiedSites = sites.filter((s) => s.coord_verified && s.latitude !== null && s.longitude !== null);
  const pendingSites = sites.filter((s) => !s.coord_verified || s.latitude === null || s.longitude === null);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-slate-100">Mapa Operacional</h2>
          <p className="text-sm text-slate-400">
            Exibe apenas sites com coordenadas verificadas ({verifiedSites.length} ativos no mapa · {pendingSites.length} com pendência cadastral).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1 rounded-md border border-slate-800 bg-[#111827] p-1">
            {(Object.keys(TILE_LAYERS) as BaseLayerKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setBaseLayer(key)}
                className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  baseLayer === key ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {TILE_LAYERS[key].label}
              </button>
            ))}
          </div>

          <select
            aria-label="Filtrar por concessão"
            value={concessionFilter}
            onChange={(e) => setConcessionFilter(e.target.value)}
            className="rounded-md border border-slate-700 bg-[#111827] px-3 py-1.5 text-xs text-slate-200 focus:border-blue-500 focus:outline-none"
          >
            <option value="ALL">Todas as concessões</option>
            {concessions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={showEdges}
              onChange={(e) => setShowEdges(e.target.checked)}
              className="rounded border-slate-600 bg-slate-900 text-blue-600"
            />
            Enlaces
          </label>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={showWeather}
              onChange={(e) => setShowWeather(e.target.checked)}
              className="rounded border-slate-600 bg-slate-900 text-blue-600"
            />
            Camada Clima
          </label>
        </div>
      </div>

      {sites.length === 0 && !loading && (
        <HonestStateBanner
          state="NO_DATA"
          title="Nenhum site cadastrado neste tenant"
          description="O mapa não gera marcadores fictícios. Cadastre sites reais e valide suas coordenadas geográficas para visualizá-los aqui."
          actionLabel="Ir para Cadastros"
          onAction={() => onNavigate('inventory')}
        />
      )}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="relative overflow-hidden rounded-lg border border-slate-800 bg-[#111827] lg:col-span-2">
          <div ref={mapContainerRef} className="h-[520px] w-full" />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 px-4 py-2.5 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              Camada: {TILE_LAYERS[baseLayer].label}
            </span>
            <span className="font-mono tabular-nums">
              Marcadores verificados: {verifiedSites.length} · Observações climáticas: {weatherEvents.length}
            </span>
          </div>
        </div>

        {/* Painel de pendências cadastrais (sites sem coordenadas verificadas) */}
        <div className="flex flex-col rounded-lg border border-slate-800 bg-[#111827]">
          <div className="border-b border-slate-800 px-4 py-3.5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Pendência de Coordenadas</h3>
              <span className="font-mono text-xs tabular-nums text-amber-400">{pendingSites.length}</span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              Sites sem latitude/longitude verificada ficam retidos nesta fila até validação manual.
            </p>
          </div>

          <div className="flex-1 divide-y divide-slate-800/80 overflow-y-auto p-4" style={{ maxHeight: '460px' }}>
            {coordFeedback && (
              <div className="mb-3 rounded border border-blue-500/40 bg-blue-950/30 p-2.5 text-xs text-blue-200">
                {coordFeedback}
              </div>
            )}

            {pendingSites.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-500">
                {sites.length === 0 ? 'Nenhum site cadastrado.' : 'Todos os sites possuem coordenadas verificadas.'}
              </div>
            ) : (
              pendingSites.map((site) => (
                <div key={site.id} className="py-3 first:pt-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-slate-200">
                        <span className="font-mono text-xs text-slate-400">{site.code}</span> · {site.name}
                      </div>
                      <div className="mt-0.5 text-xs text-slate-400">
                        {site.municipality ?? 'Município não informado'}/{site.uf ?? '—'} · Precisão: {site.coord_precision}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingSiteId(site.id);
                        setManualLat(site.latitude !== null ? String(site.latitude) : '');
                        setManualLon(site.longitude !== null ? String(site.longitude) : '');
                      }}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-700 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-800"
                    >
                      <MapPin className="h-3 w-3" aria-hidden="true" />
                      Verificar
                    </button>
                  </div>

                  {editingSiteId === site.id && (
                    <div className="mt-3 space-y-2 rounded border border-slate-700 bg-[#0B111E] p-3">
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="number"
                          step="any"
                          placeholder="Latitude (ex: -23.5505)"
                          value={manualLat}
                          onChange={(e) => setManualLat(e.target.value)}
                          className="rounded border border-slate-700 bg-[#111827] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                        />
                        <input
                          type="number"
                          step="any"
                          placeholder="Longitude (ex: -46.6333)"
                          value={manualLon}
                          onChange={(e) => setManualLon(e.target.value)}
                          className="rounded border border-slate-700 bg-[#111827] px-2.5 py-1.5 font-mono text-xs text-slate-100"
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setEditingSiteId(null)}
                          className="rounded px-2.5 py-1 text-xs text-slate-400 hover:text-slate-200"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleVerifySiteCoords(site.id)}
                          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-500"
                        >
                          <Check className="h-3 w-3" aria-hidden="true" />
                          Confirmar Coordenadas
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
