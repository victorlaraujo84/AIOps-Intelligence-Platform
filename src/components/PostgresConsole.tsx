import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ConsoleError, errorMessage, post, request } from '../lib/postgres-console.ts';
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
const resources: ReadonlyArray<{ id: string; name: string; columns: readonly Column[] }> = [
  { id: 'sites', name: 'Sites', columns: [['code', 'Código'], ['name', 'Nome'], ['municipality', 'Município'], ['uf', 'UF'], ['coord_precision', 'Coordenadas']] },
  { id: 'assets', name: 'Ativos', columns: [['name', 'Nome'], ['hostname', 'Hostname'], ['domain', 'Domínio'], ['operational_state', 'Estado']] },
  { id: 'services', name: 'Serviços', columns: [['code', 'Código'], ['name', 'Nome'], ['owner_team', 'Equipe'], ['operational_state', 'Estado']] },
  { id: 'asset-categories', name: 'Categorias', columns: [['code', 'Código'], ['label', 'Rótulo'], ['domain', 'Domínio']] },
  { id: 'concessions', name: 'Concessões', columns: [['code', 'Código'], ['name', 'Nome'], ['region', 'Região']] },
  { id: 'locality-types', name: 'Tipos de localidade', columns: [['code', 'Código'], ['label', 'Rótulo']] },
];

function Message({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-md border border-rose-800 px-3 py-2 text-sm text-rose-200">{children}</p>;
}

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

function PagedData<T extends { id: string }>({ endpoint, render }: { endpoint: string; render: (rows: T[]) => ReactNode }) {
  const [rows, setRows] = useState<T[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  async function load(after?: string, signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const url = new URL(endpoint, window.location.origin);
      if (after) url.searchParams.set('after', after);
      const page = await request<Page<T>>(url.pathname + url.search, { signal });
      setRows(previous => after ? [...previous, ...page.items] : page.items);
      setNext(page.next_after);
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
  }, [endpoint]);

  return (
    <div className="space-y-3">
      {rows.length > 0 && render(rows)}
      {loading && <p role="status" className="text-sm text-slate-400">Carregando…</p>}
      {!loading && !error && rows.length === 0 && <p className="text-sm text-slate-400">Nenhum registro disponível.</p>}
      {error && <Message>{error}</Message>}
      {next && <button className={button} disabled={loading} onClick={() => void load(next)}>Mais resultados</button>}
    </div>
  );
}

function InventoryTable({ columns, rows, onEdit, onVerify }: {
  columns: readonly Column[];
  rows: Row[];
  onEdit?: (row: Row) => void;
  onVerify?: (row: Row) => void;
}) {
  const hasActions = Boolean(onEdit || onVerify);
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
                {onEdit && <button type="button" className={button} aria-label={'Editar ' + row.name} onClick={() => onEdit(row)}>Editar</button>}
                {onVerify && <button type="button" className={button} aria-label={'Verificar coordenadas de ' + row.name}
                  onClick={() => onVerify(row)}>Verificar coordenadas</button>}
              </div>
            </td>}
          </tr>)}
        </tbody>
      </table>
    </div>
  );
}

function EditableSites({ tenant }: { tenant: string }) {
  const [editor, setEditor] = useState<{ mode: 'create' } | { mode: 'edit' | 'verify'; site: Row } | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');

  function saved(message: string) {
    setNotice(message);
    setEditor(null);
    setRevision(previous => previous + 1);
  }

  return (
    <div className="space-y-4">
      {editor === null && <button type="button" className={button} onClick={() => setEditor({ mode: 'create' })}>Novo site</button>}
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
          onEdit={editor ? undefined : site => setEditor({ mode: 'edit', site })}
          onVerify={editor ? undefined : site => setEditor({ mode: 'verify', site })}
        />
      )} />
    </div>
  );
}

function EditableAssets({ tenant, columns }: { tenant: string; columns: readonly Column[] }) {
  const [editor, setEditor] = useState<Row | 'new' | null>(null);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');

  return (
    <div className="space-y-4">
      {editor === null && <button type="button" className={button} onClick={() => setEditor('new')}>Novo ativo</button>}
      {notice && <p role="status" className="text-sm text-emerald-300">{notice}</p>}
      {editor && <PostgresAssetEditor
        key={editor === 'new' ? 'new' : editor.id}
        tenant={tenant}
        asset={editor === 'new' ? undefined : editor}
        onCancel={() => setEditor(null)}
        onSaved={() => {
          setNotice(editor === 'new' ? 'Ativo cadastrado.' : 'Ativo atualizado.');
          setEditor(null);
          setRevision(previous => previous + 1);
        }}
      />}
      <PagedData<Row> key={revision} endpoint="/inventory/assets" render={rows => (
        <InventoryTable columns={columns} rows={rows} onEdit={editor ? undefined : setEditor} />
      )} />
    </div>
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
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resource, setResource] = useState(resources[0]);

  useEffect(() => {
    const controller = new AbortController();
    void request<{ pilot_only: boolean; site_writes: boolean; asset_writes: boolean }>('/status', { signal: controller.signal })
      .then(status => {
        setShowMainLink(!status.pilot_only);
        setSiteWrites(status.site_writes);
        setAssetWrites(status.asset_writes);
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
            {identity.role === 'super_admin' && <TenantSelector key={identity.id} active={identity.active_tenant_id} busy={busy} onSwitch={id => void switchTenant(id)} />}
            {!busy && identity.active_tenant_id && (
              <section key={identity.active_tenant_id} className="space-y-4">
                <nav aria-label="Inventário e mapa" className="flex flex-wrap gap-2">
                  {[...resources, { id: 'map', name: 'Mapa', columns: [] }].map(item =>
                    <button key={item.id} aria-pressed={item.id === resource.id} className={button} onClick={() => setResource(item)}>{item.name}</button>
                  )}
                </nav>
                <h2 className="text-lg font-semibold">{resource.name}</h2>
                {mapView ? (
                  <PagedData<Marker> key="map" endpoint="/inventory/sites/map?west=-180&south=-90&east=180&north=90" render={rows => <SiteMap rows={rows} />} />
                ) : resource.id === 'sites' && mayWrite && siteWrites ? (
                  <EditableSites tenant={identity.active_tenant_id} />
                ) : resource.id === 'assets' && mayWrite && assetWrites ? (
                  <EditableAssets tenant={identity.active_tenant_id} columns={resource.columns} />
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
