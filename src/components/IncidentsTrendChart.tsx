import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { IncidentTrendPoint } from '../shared/types.ts';

interface IncidentsTrendChartProps {
  data: IncidentTrendPoint[];
  loading: boolean;
  onOpenIncidents?: () => void;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number;
    dataKey?: string;
    color?: string;
    payload?: IncidentTrendPoint;
  }>;
}

function IncidentsTooltip({ active, payload }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  const formattedDate = point.hour_utc.slice(0, 10).split('-').reverse().join('/');

  return (
    <div className="rounded-md border border-slate-700 bg-[#0B111E] px-3 py-2 text-xs shadow-lg">
      <div className="font-mono text-[11px] font-medium tabular-nums text-slate-300">
        {point.label} UTC · {formattedDate}
      </div>
      <div className="mt-1.5 space-y-1 font-mono tabular-nums">
        <div className="flex items-center justify-between gap-4 text-amber-300">
          <span>Abertos</span>
          <span className="font-semibold">{point.opened}</span>
        </div>
        <div className="flex items-center justify-between gap-4 text-emerald-300">
          <span>Resolvidos</span>
          <span className="font-semibold">{point.resolved}</span>
        </div>
      </div>
    </div>
  );
}

export function IncidentsTrendChart({ data, loading, onOpenIncidents }: IncidentsTrendChartProps) {
  const totalOpened = data.reduce((sum, item) => sum + item.opened, 0);
  const totalResolved = data.reduce((sum, item) => sum + item.resolved, 0);
  const hasAnyActivity = totalOpened > 0 || totalResolved > 0;

  return (
    <section
      aria-label="Tendência de incidentes abertos versus resolvidos nas últimas 24 horas"
      className="rounded-lg border border-slate-800 bg-[#111827] p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-slate-100">
            Tendência de Incidentes — Últimas 24h (UTC)
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">
            Comparativo horário de incidentes abertos e resolvidos registrados no banco operacional
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4 font-mono text-xs tabular-nums">
          <div className="flex items-center gap-2 text-slate-300">
            <span className="inline-block h-2.5 w-2.5 rounded-xs bg-amber-400" aria-hidden="true" />
            <span>Abertos (24h):</span>
            <span className="font-semibold text-amber-300">{data.length > 0 ? totalOpened : '—'}</span>
          </div>
          <div className="flex items-center gap-2 text-slate-300">
            <span className="inline-block h-2.5 w-2.5 rounded-xs bg-emerald-400" aria-hidden="true" />
            <span>Resolvidos (24h):</span>
            <span className="font-semibold text-emerald-300">{data.length > 0 ? totalResolved : '—'}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 h-64 w-full">
        {loading && data.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-md border border-slate-800/80 bg-[#0B111E]/50 text-xs text-slate-400">
            Carregando série temporal de incidentes...
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 12, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="incidentsOpenedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#F59E0B" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#F59E0B" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="incidentsResolvedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10B981" stopOpacity={0.32} />
                  <stop offset="95%" stopColor="#10B981" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1E293B" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="#64748B"
                tick={{ fill: '#94A3B8', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                axisLine={{ stroke: '#1E293B' }}
                interval={2}
              />
              <YAxis
                allowDecimals={false}
                stroke="#64748B"
                tick={{ fill: '#94A3B8', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<IncidentsTooltip />} />
              <Area
                type="monotone"
                dataKey="opened"
                name="Incidentes Abertos"
                stroke="#F59E0B"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#incidentsOpenedGradient)"
                activeDot={{ r: 4, fill: '#F59E0B', stroke: '#0B111E', strokeWidth: 1.5 }}
              />
              <Area
                type="monotone"
                dataKey="resolved"
                name="Incidentes Resolvidos"
                stroke="#10B981"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#incidentsResolvedGradient)"
                activeDot={{ r: 4, fill: '#10B981', stroke: '#0B111E', strokeWidth: 1.5 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {!loading && data.length > 0 && !hasAnyActivity && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-3 text-xs text-slate-400">
          <span>
            <span className="font-mono text-slate-300">NO_DATA</span> · Nenhum incidente aberto ou resolvido nas últimas 24 horas UTC.
          </span>
          {onOpenIncidents && (
            <button
              type="button"
              onClick={onOpenIncidents}
              className="font-medium text-blue-400 transition-colors hover:text-blue-300"
            >
              Ver Incidentes e RCA
            </button>
          )}
        </div>
      )}
    </section>
  );
}
