import { useEffect, useState, type FormEvent } from 'react';
import { ConsoleError, errorMessage, request } from '../lib/postgres-console.ts';
import { PostgresIncidentItsm } from './PostgresIncidentItsm.tsx';
import { Message } from './PostgresInventoryFields.tsx';

const categories = {
  eletrica: 'Elétrica',
  climatica_direta: 'Climática direta',
  composta: 'Composta',
  telecom_outros: 'Telecom',
  ti_aplicacao: 'TI / Aplicação',
  iot_sensor: 'IoT / Sensor',
  desconhecida: 'Desconhecida',
};
const statuses = { OPEN: 'Aberto', ACKNOWLEDGED: 'Reconhecido', RESOLVED: 'Resolvido' };
const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';
const field = 'w-full rounded-md border border-slate-700 bg-slate-950 p-2';
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

type Incident = {
  title: string;
  status: keyof typeof statuses;
  severity: string;
  rca_category: keyof typeof categories;
  rca_confidence: number | null;
  rca_evidence: unknown;
  rule_version: string;
  human_reviewed_at_utc: string | null;
  opened_at_utc: string;
  resolved_at_utc: string | null;
  root_site_name: string | null;
  root_asset_name: string | null;
  impacted_services_count: number;
};
type LinkedEvent = { id: string; event_type: string; source: string; observed_at_utc: string; role_in_incident: string };
type Detail = { incident: Incident; events: LinkedEvent[]; next_after: string | null };

function describeEvidence(evidence: unknown): string {
  if (typeof evidence === 'string') return evidence;
  if (evidence && typeof evidence === 'object' && 'type' in evidence && evidence.type === 'human_review'
    && 'note' in evidence && typeof evidence.note === 'string') return 'Revisão humana: ' + evidence.note;
  return JSON.stringify(evidence);
}

function ReviewForm({ incident, path, tenant, onSaved }: {
  incident: Incident; path: string; tenant: string; onSaved: () => void;
}) {
  const [category, setCategory] = useState(incident.rca_category);
  const [status, setStatus] = useState(incident.status);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const changed = category !== incident.rca_category || status !== incident.status || note.trim().length > 0;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || conflict || !changed) return;
    setError('');
    setPending(true);
    try {
      await request(path + '/rca-review', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: JSON.stringify({
          expected_review: incident.human_reviewed_at_utc,
          rca_category: category !== incident.rca_category ? category : undefined,
          status: status !== incident.status ? status : undefined,
          review_note: note.trim() || undefined,
        }),
      });
      onSaved();
    } catch (error) {
      if (error instanceof ConsoleError && error.status === 409) setConflict(true);
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-3 rounded-md border border-slate-800 p-4" onSubmit={save}>
      <h4 className="font-semibold">Revisar RCA</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>Categoria<select value={category} onChange={event => setCategory(event.target.value as typeof category)} className={field}>
          {Object.entries(categories).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label>Estado<select value={status} onChange={event => setStatus(event.target.value as typeof status)} className={field}>
          {Object.entries(statuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
      </div>
      <label className="block">Nota de revisão<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={4000} className={field} /></label>
      {error && <Message>{error}</Message>}
      <button type="submit" className={button} disabled={!changed || pending || conflict}>Salvar revisão</button>
    </form>
  );
}

export function PostgresIncidentDetail({ incidentId, tenant, mayReview, itsm, onBack }: {
  incidentId: string; tenant: string; mayReview: boolean; itsm: boolean; onBack: () => void;
}) {
  const path = '/inventory/incidents/' + incidentId;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);

  async function load(after?: string, signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const page = await request<Detail>(path + (after ? '?after=' + encodeURIComponent(after) : ''), {
        headers: { 'X-AIOps-Expected-Tenant': tenant }, signal,
      });
      setDetail(previous => after && previous ? { ...page, events: [...previous.events, ...page.events] } : page);
    } catch (error) {
      if (!signal?.aborted) setError(errorMessage(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [path, tenant, revision]);

  const incident = detail?.incident;
  const evidence = Array.isArray(incident?.rca_evidence) ? incident.rca_evidence : [];
  return (
    <div className="space-y-4">
      <button type="button" className={button} onClick={onBack}>Voltar aos incidentes</button>
      {loading && <p role="status">Carregando incidente…</p>}
      {error && <Message>{error}</Message>}
      {incident && (
        <>
          <h3 className="text-lg font-semibold">{incident.title}</h3>
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt>Estado</dt><dd>{statuses[incident.status] ?? incident.status}</dd></div>
            <div><dt>Severidade</dt><dd>{incident.severity}</dd></div>
            <div><dt>Abertura</dt><dd>{dateFormat.format(new Date(incident.opened_at_utc))}</dd></div>
            {incident.resolved_at_utc && <div><dt>Resolução</dt><dd>{dateFormat.format(new Date(incident.resolved_at_utc))}</dd></div>}
            <div><dt>Site associado</dt><dd>{incident.root_site_name ?? '—'}</dd></div>
            <div><dt>Ativo associado</dt><dd>{incident.root_asset_name ?? '—'}</dd></div>
            <div><dt>Serviços afetados</dt><dd>{incident.impacted_services_count}</dd></div>
            <div><dt>Hipótese de causa</dt><dd>{categories[incident.rca_category] ?? incident.rca_category}</dd></div>
            <div><dt>Regra de análise</dt><dd>{incident.rule_version}</dd></div>
            {incident.human_reviewed_at_utc && <div><dt>Última revisão humana</dt><dd>{dateFormat.format(new Date(incident.human_reviewed_at_utc))}</dd></div>}
          </dl>
          {evidence.length > 0 && (
            <section>
              <h4 className="font-semibold">Evidências registradas</h4>
              <ul className="list-disc break-words pl-5 text-sm">{evidence.map((item, index) => <li key={index}>{describeEvidence(item)}</li>)}</ul>
            </section>
          )}
          <section className="space-y-2">
            <h4 className="font-semibold">Eventos vinculados</h4>
            {detail.events.length === 0 ? <p className="text-sm">Nenhum evento vinculado.</p> : (
              <ul className="space-y-1 text-sm">{detail.events.map(event => (
                <li key={event.id}>{dateFormat.format(new Date(event.observed_at_utc))} · {event.event_type} · {event.source} · {event.role_in_incident}</li>
              ))}</ul>
            )}
            {detail.next_after && <button type="button" className={button} disabled={loading}
              onClick={() => void load(detail.next_after ?? undefined)}>Mais eventos</button>}
          </section>
          {itsm && <PostgresIncidentItsm incidentId={incidentId} tenant={tenant} mayRequest={mayReview} />}
          {mayReview && !loading && <ReviewForm key={incident.human_reviewed_at_utc ?? 'initial'}
            incident={incident} path={path} tenant={tenant} onSaved={() => setRevision(previous => previous + 1)} />}
        </>
      )}
    </div>
  );
}
