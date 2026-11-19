import { AlertTriangle, Database, Info, ShieldAlert } from 'lucide-react';
import type { HonestState } from '../shared/types.ts';

interface HonestStateBannerProps {
  state: HonestState;
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  provenance?: string;
}

const STATE_CONFIG: Record<
  HonestState,
  { border: string; iconColor: string; label: string; Icon: typeof Info }
> = {
  NOT_CONFIGURED: {
    border: 'border-slate-700/80 bg-[#111827]',
    iconColor: 'text-slate-400',
    label: 'NOT_CONFIGURED',
    Icon: Info,
  },
  NO_DATA: {
    border: 'border-slate-700/80 bg-[#111827]',
    iconColor: 'text-slate-400',
    label: 'NO_DATA',
    Icon: Database,
  },
  SOURCE_STALE: {
    border: 'border-amber-500/30 bg-[#111827]',
    iconColor: 'text-amber-400',
    label: 'SOURCE_STALE',
    Icon: AlertTriangle,
  },
  INSUFFICIENT_DATA: {
    border: 'border-amber-500/30 bg-[#111827]',
    iconColor: 'text-amber-400',
    label: 'INSUFFICIENT_DATA',
    Icon: AlertTriangle,
  },
  MODEL_NOT_VALIDATED: {
    border: 'border-amber-500/30 bg-[#111827]',
    iconColor: 'text-amber-400',
    label: 'MODEL_NOT_VALIDATED',
    Icon: ShieldAlert,
  },
  PREDICTION_UNAVAILABLE: {
    border: 'border-red-500/30 bg-[#111827]',
    iconColor: 'text-red-400',
    label: 'PREDICTION_UNAVAILABLE',
    Icon: ShieldAlert,
  },
};

export function HonestStateBanner({
  state,
  title,
  description,
  actionLabel,
  onAction,
  provenance,
}: HonestStateBannerProps) {
  const cfg = STATE_CONFIG[state];
  const Icon = cfg.Icon;

  return (
    <div className={`rounded-lg border ${cfg.border} p-5`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3.5">
          <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${cfg.iconColor}`} aria-hidden="true" />
          <div className="space-y-1.5">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <span className={`font-mono font-semibold ${cfg.iconColor}`}>{cfg.label}</span>
              {provenance && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono">{provenance}</span>
                </>
              )}
            </div>
            <h3 className="text-base font-semibold text-slate-100">{title}</h3>
            <p className="max-w-3xl text-sm leading-relaxed text-slate-400">{description}</p>
          </div>
        </div>
        {actionLabel && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="shrink-0 whitespace-nowrap rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400"
          >
            {actionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
