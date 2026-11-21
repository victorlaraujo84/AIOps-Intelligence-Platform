import { useState, type FormEvent } from 'react';
import { errorMessage, request } from '../lib/postgres-console.ts';
import { button, field } from './PostgresInventoryFields.tsx';

type Service = { id: string } & Record<string, string | number | null>;

export function PostgresServiceEditor({ tenant, record, onCancel, onSaved }: {
  tenant: string;
  record?: Service;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const payload: Record<string, string | number | null> = {};
    for (const [name, raw] of new FormData(event.currentTarget)) {
      if (typeof raw !== 'string') continue;
      const text = raw.trim();
      const value = text ? (name === 'sla_target_pct' ? Number(text) : text) : null;
      if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || value > 100)) {
        setError('Informe uma meta de SLA entre 0% e 100%.');
        return;
      }
      if (!record || value !== (record[name] ?? null)) payload[name] = value;
    }
    if (Object.keys(payload).length === 0) {
      setError('Altere pelo menos um campo para salvar.');
      return;
    }
    setPending(true);
    setError('');
    try {
      await request(record ? '/inventory/services/' + record.id : '/inventory/services', {
        method: record ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: JSON.stringify(payload),
      });
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-4" onSubmit={save}>
      <h3 className="font-semibold">{record ? 'Editar serviço' : 'Novo serviço'}</h3>
      <fieldset disabled={pending} className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm"><span>Código</span>
          <input className={field} name="code" maxLength={64} defaultValue={record?.code ?? ''} disabled={Boolean(record)} required />
        </label>
        <label className="space-y-1 text-sm"><span>Nome</span>
          <input className={field} name="name" maxLength={200} defaultValue={record?.name ?? ''} required />
        </label>
        <label className="space-y-1 text-sm"><span>Domínio</span>
          <input className={field} name="domain" maxLength={80} defaultValue={record?.domain ?? 'ti'} required />
        </label>
        <label className="space-y-1 text-sm"><span>Equipe responsável</span>
          <input className={field} name="owner_team" maxLength={200} defaultValue={record?.owner_team ?? ''} />
        </label>
        <div className="space-y-1 text-sm">
          <label htmlFor="service-criticality">Criticidade</label>
          <select id="service-criticality" className={field} name="criticality" defaultValue={record?.criticality ?? 'alta'}>
            <option value="critica">Crítica</option>
            <option value="alta">Alta</option>
            <option value="media">Média</option>
            <option value="baixa">Baixa</option>
          </select>
        </div>
        <label className="space-y-1 text-sm"><span>Meta de SLA (%)</span>
          <input className={field} name="sla_target_pct" type="number" min={0} max={100} step="any"
            defaultValue={record?.sla_target_pct ?? ''} />
        </label>
        <label className="space-y-1 text-sm sm:col-span-2"><span>Descrição</span>
          <textarea className={field} name="description" maxLength={4000} rows={3} defaultValue={record?.description ?? ''} />
        </label>
      </fieldset>
      {error && <p role="alert" className="text-sm text-rose-200">{error}</p>}
      <div className="flex gap-2">
        <button className={button} type="submit" disabled={pending}>{pending ? 'Salvando…' : 'Salvar serviço'}</button>
        <button className={button} type="button" disabled={pending} onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  );
}
