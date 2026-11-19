import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Database } from 'lucide-react';

type DbHealthState = 'checking' | 'connected' | 'error';

interface HealthPayload {
  status?: string;
  db?: string;
  timestamp_utc?: string;
}

export function HealthStatusBadge() {
  const [dbState, setDbState] = useState<DbHealthState>('checking');
  const [lastCheckedUtc, setLastCheckedUtc] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const checkHealth = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch('/api/health', { cache: 'no-store' });
      const data = (await response.json().catch(() => ({}))) as HealthPayload;
      if (response.ok && data.db === 'connected') {
        setDbState('connected');
      } else {
        setDbState('error');
      }
      setLastCheckedUtc(data.timestamp_utc ?? new Date().toISOString());
    } catch {
      setDbState('error');
      setLastCheckedUtc(new Date().toISOString());
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void checkHealth();
    const timer = window.setInterval(() => {
      void checkHealth();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [checkHealth]);

  const badgeStyle =
    dbState === 'connected'
      ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-300 hover:border-emerald-400/60'
      : dbState === 'error'
        ? 'border-red-500/50 bg-red-950/40 text-red-300 hover:border-red-400/70'
        : 'border-amber-500/40 bg-amber-950/30 text-amber-300 hover:border-amber-400/60';

  const statusText =
    dbState === 'connected' ? 'BD: Conectado' : dbState === 'error' ? 'BD: Erro' : 'BD: Verificando...';

  const Icon = dbState === 'connected' ? CheckCircle2 : dbState === 'error' ? AlertTriangle : Database;

  return (
    <button
      type="button"
      onClick={() => void checkHealth()}
      disabled={refreshing}
      aria-label={`Estado de saúde do banco de dados: ${statusText}`}
      title={
        lastCheckedUtc
          ? `Clique para revalidar /api/health · Última verificação (UTC): ${lastCheckedUtc}`
          : 'Clique para consultar /api/health'
      }
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1.5 font-mono text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 ${badgeStyle}`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{statusText}</span>
    </button>
  );
}
