import { useEffect, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ConsoleError, errorMessage, post, request } from '../lib/postgres-console.ts';
import { Message, PagedData } from './PostgresInventoryFields.tsx';
import { PostgresTenantCreator, type NewTenant } from './PostgresTenantCreator.tsx';
import { PostgresTenantUsers } from './PostgresTenantUsers.tsx';
import { PostgresIncidentDetail } from './PostgresIncidentDetail.tsx';
import { PostgresTopology } from './PostgresTopology.tsx';
import { isWritableCatalog, PostgresCatalogCreate } from './PostgresCatalogCreate.tsx';
import { PostgresServiceDependencies } from './PostgresServiceDependencies.tsx';
import { PostgresServiceEditor } from './PostgresServiceEditor.tsx';
import { PostgresAssetEditor } from './PostgresAssetEditor.tsx';
import { PostgresSiteCoordinates, PostgresSiteEditor } from './PostgresSiteEditor.tsx';

type Tenant = { id: string; name: string; slug: string };
type Identity = { id: string; full_name: string; role: string; active_tenant_id: string | null };
type Page<T> = { items: T[]; next_after: string | null };
type Row = { id: string } & Record<string, string | number | null>;
type Marker = { id: string; name: string; latitude: number; longitude: number };
type Column = readonly [key: string, label: string];

const button = 'rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-60';
const input = 'w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100';
const recordTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });
const resources: ReadonlyArray<{ id: string; name: string; columns: readonly Column[]; feed?: string }> = [
  { id: 'sites', name: 'Sites', columns: [['code', 'Código'], ['name', 'Nome'], ['municipality', 'Município'], ['uf', 'UF'], ['coord_precision', 'Coordenadas']] },
  { id: 'assets', name: 'Ativos', columns: [['name', 'Nome'], ['hostname', 'Hostname'], ['domain', 'Domínio'], ['operational_state', 'Estado']] },
  { id: 'services', name: 'Serviços', columns: [['code', 'Código'], ['name', 'Nome'], ['owner_team', 'Equipe'], ['sla_target_pct', 'Meta de SLA (%)'], ['operational_state', 'Estado']] },
  { id: 'topology', name: 'Topologia', columns: [] },
  { id: 'asset-categories', name: 'Categorias', columns: [['code', 'Código'], ['label', 'Rótulo'], ['domain', 'Domínio']] },
  { id: 'concessions', name: 'Concessões', columns: [['code', 'Código'], ['name', 'Nome'], ['region', 'Região']] },
  { id: 'locality-types', name: 'Tipos de localidade', columns: [['code', 'Código'], ['label', 'Rótulo']] },
  { id: 'audit', name: 'Auditoria', feed: '/inventory/audit', columns: [
    ['created_at_utc', 'Horário'], ['action', 'Ação'], ['actor_role', 'Papel do autor'],
    ['resource_type', 'Tipo de recurso'], ['resource_id', 'Identificador do recurso'],
  ] },
  { id: 'connectors', name: 'Conectores', columns: [['name', 'Nome'], ['connector_type', 'Tipo'], ['status', 'Último estado registrado'], ['last_sync_at_utc', 'Última sincronização']] },
  { id: 'events', name: 'Eventos', feed: '/inventory/feed/events', columns: [
    ['created_at_utc', 'Horário'], ['event_type', 'Tipo'], ['source', 'Origem'], ['status', 'Estado'], ['quality_flag', 'Qualidade'],
  ] },
  { id: 'incidents', name: 'Incidentes', feed: '/inventory/feed/incidents', columns: [
    ['created_at_utc', 'Abertura'], ['title', 'Título'], ['status', 'Estado'], ['severity', 'Severidade'],
    ['impacted_services_count', 'Serviços afetados'],
  ] },
  { id: 'metrics', name: 'Métricas', feed: '/inventory/feed/metrics', columns: [
    ['created_at_utc', 'Horário'], ['metric_name', 'Métrica'], ['value_num', 'Valor'], ['unit', 'Unidade'],
    ['source', 'Origem'], ['quality_flag', 'Qualidade'],
  ] },
  { id: 'logs', name: 'Logs', feed: '/inventory/feed/logs', columns: [
    ['created_at_utc', 'Horário'], ['severity', 'Severidade'], ['source', 'Origem'], ['message', 'Mensagem'],
  ] },
  { id: 'anomalies', name: 'Anomalias', feed: '/inventory/feed/anomalies', columns: [
    ['created_at_utc', 'Horário'], ['metric_name', 'Métrica'], ['severity', 'Severidade'], ['status', 'Estado'], ['z_score', 'Escore Z'],
  ] },
];

function SignIn({ onLogin }: { onLogin: (identity: Identity) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setPending(true);
    setError('');
    try {
      await post('/login', { email: fields.get('email'), password: fields.get('password') });
      onLogin(await request<Identity>('/me'));
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      const password = form.elements.namedItem('password');
      if (password instanceof HTMLInputElement) password.value = '';
      setPending(false);
    }
  }

  return (
    <form className="mx-auto max-w-sm space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-6" onSubmit={submit}>
      <h2 className="text-lg font-semibold">Entrar na homologação</h2>
      <label className="block text-sm">E-mail
        <input className={input} name="email" type="email" autoComplete="username" maxLength={254} required />
      </label>
      <label className="block text-sm">Senha
        <input className={input} name="password" type="password" autoComplete="current-password" maxLength={1024} required />
      </label>
      {error && <Message>{error}</Message>}
      <button className={button} type="submit" disabled={pending}>{pending ? 'Entrando…' : 'Entrar'}</button>
    </form>
  );
}

function TenantSelector({ active, busy, onSwitch }: {
  active: string | null;
  busy: boolean;
  onSwitch: (id: string) => void;
}) {
  const [options, setOptions] = useState<Tenant[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function load(after?: string, signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams(after ? { after } : {});
      const page = await request<Page<Tenant>>('/tenants?' + query, { signal });
      setOptions(previous => after ? [...previous, ...page.items] : page.items);
      setCursor(page.next_after);
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
  }, []);

  return (
    <div className="mb-5 flex flex-wrap items-end gap-3">
      <label className="min-w-56 text-sm">Tenant ativo
        <select className={input} value={active ?? ''} disabled={busy || loading} onChange={event => onSwitch(event.target.value)}>
          <option value="" disabled>Selecione um tenant</option>
          {active && !options.some(item => item.id === active) && <option value={active}>Tenant atual</option>}
          {options.map(tenant => <option key={tenant.id} value={tenant.id}>{tenant.name} ({tenant.slug})</option>)}
        </select>
      </label>
      {cursor && <button className={button} disabled={busy || loading} onClick={() => void load(cursor)}>Mais tenants</button>}
      {error && <Message>{error}</Message>}
    </div>
  );
}

function InventoryTable({ columns, rows, onEdit, onVerify, onDependencies, onView, onRemove, removalDisabled, removalResource }: {
  columns: readonly Column[];
  rows: Row[];
  onEdit?: (row: Row) => void;
  onVerify?: (row: Row) => void;
  onView?: (row: Row) => void;
  onDependencies?: (row: Row) => void;
  onRemove?: (row: Row) => void;
  removalDisabled?: boolean;
  removalResource?: string;
}) {
  const hasActions = Boolean(onEdit || onVerify || onDependencies || onView || onRemove);
  return (
    <div className="overflow-x-auto rounded-md border border-slate-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-slate-900 text-slate-300">
          <tr>
            {columns.map(([key, label]) => <th key={key} scope="col" className="px-3 py-2">{label}</th>)}
            {hasActions && <th scope="col" className="px-3 py-2">Ações</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => <tr key={row.id} className="border-t border-slate-800">
            {columns.map(([key]) => <td key={key} className="px-3 py-2">{row[key] ?? '—'}</td>)}
            {hasActions && <td className="px-3 py-2">
              <div className="flex flex-wrap gap-2">
                {onView && <button type="button" className={button} aria-label={'Detalhes de ' + row.title} onClick={() => onView(row)}>Detalhes</button>}
                {onEdit && <button type="button" className={button} aria-label={'Editar ' + row.name} onClick={() => onEdit(row)}>Editar</button>}
                {onVerify && <button type="button" className={button} aria-label={'Verificar coordenadas de ' + row.name}
                  onClick={() => onVerify(row)}>Verificar coordenadas</button>}
                {onDependencies && <button type="button" className={button} aria-label={'Dependências de ' + row.name}
                  onClick={() => onDependencies(row)}>Dependências</button>}
                {onRemove && <button type="button" className={button} aria-label={['Excluir', removalResource, row.name].filter(Boolean).join(' ')}
                  disabled={removalDisabled} onClick={() => onRemove(row)}>Excluir</button>}
              </div>
            </td>}
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

function useInventoryRemoval(endpoint: string, tenant: string) {
  const [removalError, setRemovalError] = useState('');
  const [removing, setRemoving] = useState(false);

  async function remove(id: string, warning: string, onStart: () => void, onRemoved: () => void) {
    if (!window.confirm(warning)) return;
    setRemoving(true);
    setRemovalError('');
    onStart();
    try {
      await request(endpoint + '/' + id, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-AIOps-Expected-Tenant': tenant },
        body: '{}',
      });
      onRemoved();
    } catch (error) {
      setRemovalError(errorMessage(error));
    } finally {
      setRemoving(false);
    }
  }

  return { remove, removing, removalError };
}

function EditableSites({ tenant, mayRemove }: { tenant: string; mayRemove: boolean }) {
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit' | 'verify'; site: Row } | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const { remove, removing, removalError } = useInventoryRemoval('/inventory/sites', tenant);

  function removeSite(site: Row) {
    const warning = `Excluir o site “${site.name}”? Os ativos serão mantidos e ficarão sem site.`;
    void remove(site.id, warning, () => setNotice(''), () => saved('Site excluído.'));
  }

  function saved(message: string) {
    setNotice(message);
    setEditor(null);
    setRevision(previous => previous + 1);
  }

  return (
    <div className="space-y-4">
      {editor === null && <button type="button" className={button} disabled={removing} onClick={() => setEditor({ mode: 'create' })}>Novo site</button>}
      {removalError && <Message>{removalError}</Message>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      {editor?.mode === 'verify' && <PostgresSiteCoordinates
        key={editor.site.id}
        tenant={tenant}
        site={editor.site}
        onCancel={() => setEditor(null)}
        onSaved={() => saved('Coordenadas verificadas.')}
      />}
      {editor && editor.mode !== 'verify' && <PostgresSiteEditor
        key={editor.mode === 'create' ? 'new' : editor.site.id}
        tenant={tenant}
        site={editor.mode === 'create' ? undefined : editor.site}
        onCancel={() => setEditor(null)}
        onSaved={() => saved(editor.mode === 'create' ? 'Site cadastrado.' : 'Site atualizado.')}
      />}
      <PagedData<Row> key={revision} endpoint="/inventory/sites" render={rows => (
        <InventoryTable columns={resources[0].columns} rows={rows}
          onEdit={editor || removing ? undefined : site => setEditor({ mode: 'edit', site })}
          onVerify={editor || removing ? undefined : site => setEditor({ mode: 'verify', site })}
          onRemove={mayRemove ? removeSite : undefined}
          removalResource="site" removalDisabled={removing || Boolean(editor)}
        />
      )} />
    </div>
  );
}

const inventoryEditors = {
  assets: {
    Editor: PostgresAssetEditor, newLabel: 'Novo ativo', created: 'Ativo cadastrado.', updated: 'Ativo atualizado.',
    removal: {
      resource: 'ativo', done: 'Ativo excluído.',
      warning: (name: string) => `Excluir o ativo “${name}”? Os enlaces e as dependências de serviço deste ativo serão removidos.`,
    },
  },
  services: {
    Editor: PostgresServiceEditor, newLabel: 'Novo serviço', created: 'Serviço cadastrado.', updated: 'Serviço atualizado.',
    removal: {
      resource: 'serviço', done: 'Serviço excluído.',
      warning: (name: string) => `Excluir o serviço “${name}”? As dependências dele e os vínculos de outros serviços com ele serão removidos.`,
    },
  },
};

function EditableInventory({ tenant, resource, columns, onDependencies, mayRemove = false }: {
  tenant: string;
  resource: keyof typeof inventoryEditors;
  columns: readonly Column[];
  onDependencies?: (row: Row) => void;
  mayRemove?: boolean;
}) {
  const { Editor, newLabel, created, updated, removal } = inventoryEditors[resource];
  const [editor, setEditor] = useState<Row | 'new' | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const endpoint = '/inventory/' + resource;
  const { remove, removing, removalError } = useInventoryRemoval(endpoint, tenant);

  function removeRecord(record: Row) {
    void remove(record.id, removal.warning(String(record.name)), () => setNotice(''), () => {
      setNotice(removal.done);
      setRevision(previous => previous + 1);
    });
  }

  return (
    <div className="space-y-4">
      {editor === null && <button type="button" className={button} disabled={removing} onClick={() => setEditor('new')}>{newLabel}</button>}
      {removalError && <Message>{removalError}</Message>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      {editor && <Editor
        key={editor === 'new' ? 'new' : editor.id}
        tenant={tenant}
        record={editor === 'new' ? undefined : editor}
        onCancel={() => setEditor(null)}
        onSaved={() => {
          setNotice(editor === 'new' ? created : updated);
          setEditor(null);
          setRevision(previous => previous + 1);
        }}
      />}
      <PagedData<Row> key={revision} endpoint={endpoint} render={rows => (
        <InventoryTable columns={columns} rows={rows} onEdit={editor || removing ? undefined : setEditor}
          onDependencies={editor || removing ? undefined : onDependencies}
          onRemove={mayRemove ? removeRecord : undefined}
          removalResource={removal.resource} removalDisabled={removing || Boolean(editor)} />
      )} />
    </div>
  );
}

function ServicesInventory({ tenant, columns, mayWrite, mayRemove }: {
  tenant: string;
  columns: readonly Column[];
  mayWrite: boolean;
  mayRemove: boolean;
}) {
  const [service, setService] = useState<Row | null>(null);
  if (service) return <PostgresServiceDependencies
    service={{ id: service.id, name: String(service.name) }}
    tenant={tenant}
    mayWrite={mayWrite}
    onBack={() => setService(null)}
  />;
  if (mayWrite) return <EditableInventory tenant={tenant} resource="services" columns={columns}
    onDependencies={setService} mayRemove={mayRemove} />;
  return <PagedData<Row> endpoint="/inventory/services" render={rows => (
    <InventoryTable columns={columns} rows={rows} onDependencies={setService} />
  )} />;
}

function IncidentInventory({ tenant, mayReview, itsm, columns }: { tenant: string; mayReview: boolean; itsm: boolean; columns: readonly Column[] }) {
  const [incident, setIncident] = useState<string | null>(null);
  if (incident) {
    return <PostgresIncidentDetail incidentId={incident} tenant={tenant} mayReview={mayReview} itsm={itsm} onBack={() => setIncident(null)} />;
  }
  return (
    <PagedData<Row> endpoint="/inventory/feed/incidents" expectedTenant={tenant} render={rows => (
      <InventoryTable columns={columns} onView={row => setIncident(row.id)}
        rows={rows.map(row => ({ ...row, created_at_utc: recordTime.format(new Date(String(row.created_at_utc))) }))} />
    )} />
  );
}

function SiteMap({ rows }: { rows: Marker[] }) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);

  useEffect(() => {
    if (!element.current) return;
    const instance = L.map(element.current, { center: [0, 0], zoom: 2, worldCopyJump: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(instance);
    markers.current = L.layerGroup().addTo(instance);
    map.current = instance;
    return () => {
      instance.remove();
      map.current = null;
      markers.current = null;
    };
  }, []);

  useEffect(() => {
    const group = markers.current;
    if (!map.current || !group) return;
    group.clearLayers();
    const points = rows.map(row => {
      const point = L.latLng(row.latitude, row.longitude);
      const label = document.createElement('span');
      label.textContent = row.name;
      L.circleMarker(point, { radius: 7, color: '#2563eb', fillOpacity: 0.8 }).bindTooltip(label).addTo(group);
      return point;
    });
    map.current.fitBounds(L.latLngBounds(points), { padding: [30, 30], maxZoom: 12 });
  }, [rows]);

  return (
    <>
      <div ref={element} className="h-80 rounded-lg bg-slate-800" aria-label="Mapa de sites verificados" />
      <ul className="space-y-1 text-sm text-slate-200" aria-label="Sites no mapa">
        {rows.map(row => <li key={row.id}>{row.name} · {row.latitude}, {row.longitude}</li>)}
      </ul>
    </>
  );
}

export default function PostgresConsole() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(true);
  const [unavailable, setUnavailable] = useState('');
  const [showMainLink, setShowMainLink] = useState(false);
  const [siteWrites, setSiteWrites] = useState(false);
  const [assetWrites, setAssetWrites] = useState(false);
  const [serviceWrites, setServiceWrites] = useState(false);
  const [incidentWrites, setIncidentWrites] = useState(false);
  const [itsm, setItsm] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [userAdmin, setUserAdmin] = useState(false);
  const [tenantCreation, setTenantCreation] = useState(false);
  const [tenantListRevision, setTenantListRevision] = useState(0);
  const [selectedResource, setResource] = useState<(typeof resources)[number]>(resources[0]);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ pilot_only: boolean; site_writes: boolean; asset_writes: boolean; service_writes: boolean; incident_writes: boolean; itsm: boolean; user_admin: boolean; tenant_creation: boolean }>('/status', { signal: controller.signal })
      .then(status => {
        setShowMainLink(!status.pilot_only);
        setSiteWrites(status.site_writes);
        setAssetWrites(status.asset_writes);
        setServiceWrites(status.service_writes);
        setIncidentWrites(status.incident_writes);
        setItsm(status.itsm);
        setUserAdmin(status.user_admin);
        setTenantCreation(status.tenant_creation);
      })
      .catch(() => { if (!controller.signal.aborted) setShowMainLink(true); });
    void request<Identity>('/me', { signal: controller.signal })
      .then(setIdentity)
      .catch(error => {
        if (!controller.signal.aborted && !(error instanceof ConsoleError && error.status === 401)) {
          setUnavailable(errorMessage(error));
        }
      })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  async function switchTenant(tenantId: string) {
    if (!identity || !tenantId) return;
    setBusy(true);
    setError('');
    try {
      const selected = await post<{ active_tenant_id: string }>('/switch-tenant', { tenant_id: tenantId });
      setIdentity({ ...identity, active_tenant_id: selected.active_tenant_id });
    } catch (error) {
      setError(errorMessage(error));
      try {
        setIdentity(await request<Identity>('/me'));
      } catch {
        setIdentity(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function createTenant(data: NewTenant) {
    setBusy(true);
    try {
      const created = await post<Tenant & { active_tenant_id: string }>('/tenants', data);
      setIdentity(current => current && { ...current, active_tenant_id: created.active_tenant_id });
      setTenantListRevision(previous => previous + 1);
      return created.name;
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    setError('');
    try {
      await post('/logout');
      setIdentity(null);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const isAdmin = identity?.role === 'super_admin' || identity?.role === 'tenant_admin';
  const mayAdministerUsers = userAdmin && isAdmin;
  const resource = selectedResource.id === 'users' && !mayAdministerUsers ? resources[0] : selectedResource;
  const mapView = resource.id === 'map';
  const mayWrite = identity !== null
    && ['super_admin', 'tenant_admin', 'tenant_operator'].includes(identity.role);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <h1 className="font-semibold">Inventário PostgreSQL</h1>
          <div className="flex items-center gap-4">
            {identity && <button className={button} disabled={busy} onClick={() => void logout()}>Sair</button>}
            {showMainLink && <a className="text-sm text-sky-400 hover:underline" href="/">Voltar ao console</a>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl space-y-4 px-4 py-6 sm:px-6">
        {checking && <p role="status" className="text-sm text-slate-400">Verificando sessão…</p>}
        {unavailable && <Message>{unavailable}</Message>}
        {error && <Message>{error}</Message>}
        {!checking && !unavailable && !identity && <SignIn onLogin={setIdentity} />}
        {identity && (
          <>
            <p className="text-sm text-slate-300">{identity.full_name} · Consulta em homologação</p>
            {identity.role === 'super_admin' && (
              <>
                <TenantSelector key={identity.id + ':' + tenantListRevision}
                  active={identity.active_tenant_id} busy={busy} onSwitch={id => void switchTenant(id)} />
                {tenantCreation && <PostgresTenantCreator busy={busy} onCreate={createTenant} />}
              </>
            )}
            {!busy && identity.active_tenant_id && (
              <section key={identity.active_tenant_id} className="space-y-4">
                <nav aria-label="Inventário e mapa" className="flex flex-wrap gap-2">
                  {[...resources, { id: 'map', name: 'Mapa', columns: [] },
                    ...(mayAdministerUsers ? [{ id: 'users', name: 'Usuários', columns: [] }] : [])].map(item =>
                    <button key={item.id} aria-pressed={item.id === resource.id} className={button} onClick={() => setResource(item)}>{item.name}</button>
                  )}
                </nav>
                <h2 className="text-lg font-semibold">{resource.name}</h2>
                {mapView ? (
                  <PagedData<Marker> key="map" endpoint="/inventory/sites/map?west=-180&south=-90&east=180&north=90" render={rows => <SiteMap rows={rows} />} />
                ) : resource.id === 'sites' && mayWrite && siteWrites ? (
                  <EditableSites tenant={identity.active_tenant_id} mayRemove={isAdmin} />
                ) : resource.id === 'assets' && mayWrite && assetWrites ? (
                  <EditableInventory key="assets" tenant={identity.active_tenant_id} resource="assets" columns={resource.columns} mayRemove={isAdmin} />
                ) : isWritableCatalog(resource.id) ? (
                  <PostgresCatalogCreate<Row> key={resource.id} catalog={resource.id} tenant={identity.active_tenant_id}
                    mayWrite={mayWrite && (resource.id === 'asset-categories' ? assetWrites : siteWrites)}
                    mayRemove={resource.id === 'concessions' && siteWrites && isAdmin}
                    render={(rows, onRemove, disabled) => (
                      <InventoryTable columns={resource.columns} rows={rows} onRemove={onRemove} removalDisabled={disabled} removalResource="concessão" />
                    )} />
                ) : resource.id === 'incidents' ? (
                  <IncidentInventory tenant={identity.active_tenant_id} columns={resource.columns}
                    mayReview={mayWrite && incidentWrites} itsm={itsm} />
                ) : resource.feed ? (
                  <PagedData<Row> key={resource.id} endpoint={resource.feed} expectedTenant={identity.active_tenant_id}
                    render={rows => <InventoryTable columns={resource.columns} rows={rows.map(row => ({
                      ...row, created_at_utc: recordTime.format(new Date(String(row.created_at_utc))),
                    }))} />} />
                ) : resource.id === 'users' ? (
                  <PostgresTenantUsers tenant={identity.active_tenant_id} actor={identity.id} />
                ) : resource.id === 'topology' ? (
                  <PostgresTopology tenant={identity.active_tenant_id} mayWrite={mayWrite && assetWrites} />
                ) : resource.id === 'services' ? (
                  <ServicesInventory tenant={identity.active_tenant_id} columns={resource.columns}
                    mayWrite={mayWrite && serviceWrites} mayRemove={isAdmin} />
                ) : (
                  <PagedData<Row> key={resource.id} endpoint={'/inventory/' + resource.id} render={rows => <InventoryTable columns={resource.columns} rows={rows} />} />
                )}
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}
