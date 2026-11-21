import { getOpenMeteoCurrent } from './open-meteo-current.ts';
import { Router, type CookieOptions, type Request, type Response } from 'express';
import { SlidingWindowRateLimiter } from './security.ts';

const COOKIE_NAME = '__Host-aiops_pg_session';
const COOKIE_OPTIONS: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
const API = 'http://api:8000/api/v1';
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;
const FEEDS = new Set(['events', 'incidents', 'metrics', 'logs', 'anomalies']);
const INVENTORY = new Set(['sites', 'assets', 'services', 'asset-categories', 'concessions', 'locality-types', 'connectors']);

function sessionToken(req: Request): string | undefined {
  const token = req.headers.cookie?.split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);
  return token && SESSION_PATTERN.test(token) ? token : undefined;
}

async function callCore(path: string, token?: string, payload?: object, expectedTenant?: string, method?: 'PATCH' | 'DELETE') {
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (payload) headers.set('Content-Type', 'application/json');
  if (expectedTenant) headers.set('X-AIOps-Expected-Tenant', expectedTenant);
  try {
    const upstream = await fetch(API + path, {
      headers,
      method: method ?? (payload ? 'POST' : 'GET'),
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (upstream.status === 204) return { status: 204 };
    if (upstream.ok) return { status: upstream.status, body: await upstream.json() };
    if (upstream.status < 500) {
      const data = await upstream.json();
      const error = typeof data?.detail === 'string' ? data.detail : 'Dados da consulta inválidos.';
      return { status: upstream.status, body: { error } };
    }
  } catch {
    // O navegador recebe uma mensagem genérica quando o serviço interno falha.
  }
  return { status: 503, body: { error: 'Console PostgreSQL temporariamente indisponível.' } };
}

function queryFor(req: Request, fields: readonly string[]): string {
  const query = new URLSearchParams();
  for (const field of fields) {
    const value = req.query[field];
    if (typeof value === 'string') query.set(field, value);
  }
  return '?' + query.toString();
}

function authenticated(req: Request, res: Response): string | undefined {
  const token = sessionToken(req);
  if (!token) res.status(401).json({ error: 'Sessão PostgreSQL necessária.' });
  return token;
}

function forward(res: Response, result: Awaited<ReturnType<typeof callCore>>) {
  if (result.status === 204) res.status(204).end();
  else res.status(result.status).json(result.body);
}

export function postgresConsoleRouter(enabled: boolean, pilotOnly: boolean, siteWrites: boolean): Router {
  const router = Router();
  const assetWrites = pilotOnly && process.env.AIOPS_POSTGRES_PILOT_WRITE_ASSETS === 'true';
  const serviceWrites = pilotOnly && process.env.AIOPS_POSTGRES_PILOT_WRITE_SERVICES === 'true';
  const connectorWrites = pilotOnly && process.env.AIOPS_POSTGRES_CONNECTOR_WRITES === 'true';
  const incidentWrites = pilotOnly && process.env.AIOPS_POSTGRES_INCIDENT_WRITES === 'true';
  const itsm = pilotOnly && process.env.AIOPS_POSTGRES_ITSM === 'true';
  const userAdmin = pilotOnly && process.env.AIOPS_POSTGRES_PILOT_MANAGE_USERS === 'true';
  const tenantCreation = pilotOnly && process.env.AIOPS_POSTGRES_PILOT_CREATE_TENANTS === 'true';
  const limiter = new SlidingWindowRateLimiter(30, 15 * 60 * 1000);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) {
      res.status(404).json({ error: 'Console PostgreSQL indisponível.' });
      return;
    }
    const mutation = ['POST', 'PATCH', 'DELETE'].includes(req.method);
    if (mutation && (!req.is('application/json') || req.get('sec-fetch-site') === 'cross-site')) {
      res.status(403).json({ error: 'Envie a operação pelo console de homologação.' });
      return;
    }
    next();
  });

  router.get('/status', (_req, res) => {
    res.json({ enabled: true, pilot_only: pilotOnly, site_writes: siteWrites, asset_writes: assetWrites, service_writes: serviceWrites,
      user_admin: userAdmin, tenant_creation: tenantCreation, incident_writes: incidentWrites, connector_writes: connectorWrites, itsm });
  });

  router.post('/login', async (req, res) => {
    if (!limiter.check(req.ip ?? req.socket.remoteAddress ?? 'unknown').allowed) {
      res.status(429).json({ error: 'Muitas tentativas de autenticação. Aguarde alguns minutos.' });
      return;
    }
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 1024) {
      res.status(422).json({ error: 'Dados de autenticação inválidos.' });
      return;
    }
    const result = await callCore('/auth/login', undefined, { email, password });
    if (result.status !== 200) {
      forward(res, result);
      return;
    }
    const token = result.body?.access_token;
    if (typeof token !== 'string' || !SESSION_PATTERN.test(token)) {
      res.status(503).json({ error: 'Sessão PostgreSQL indisponível.' });
      return;
    }
    res.cookie(COOKIE_NAME, token, { ...COOKIE_OPTIONS, maxAge: 12 * 60 * 60 * 1000 });
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    const token = authenticated(req, res);
    if (token) forward(res, await callCore('/auth/me', token));
  });

  router.get('/tenants', async (req, res) => {
    const token = authenticated(req, res);
    if (token) forward(res, await callCore('/auth/tenants' + queryFor(req, ['after', 'limit']), token));
  });

  if (tenantCreation) {
    router.post('/tenants', async (req, res) => {
      const token = authenticated(req, res);
      if (token) forward(res, await callCore('/auth/tenants', token, req.body ?? {}));
    });
  }

  router.post('/switch-tenant', async (req, res) => {
    const token = authenticated(req, res);
    if (token) forward(res, await callCore('/auth/switch-tenant', token, { tenant_id: req.body?.tenant_id }));
  });

  router.post('/logout', async (req, res) => {
    const token = sessionToken(req);
    const result = token ? await callCore('/auth/logout', token, {}) : { status: 204 };
    if (result.status === 204 || result.status === 401) {
      res.clearCookie(COOKIE_NAME, COOKIE_OPTIONS);
      res.status(204).end();
      return;
    }
    forward(res, result);
  });

  if (userAdmin) {
    async function tenantUsers(req: Request, res: Response) {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      const id = req.params.userId;
      if (!expected || !UUID_PATTERN.test(expected) || (id && !UUID_PATTERN.test(id))) {
        res.status(422).json({ error: 'Identificador de usuário ou tenant inválido.' });
        return;
      }
      const path = '/tenant-users';
      if (req.method === 'GET') {
        forward(res, await callCore(path + queryFor(req, ['after', 'limit']), token, undefined, expected));
      } else if (id) {
        forward(res, await callCore(path + '/' + id + '/status', token, req.body ?? {}, expected, 'PATCH'));
      } else {
        forward(res, await callCore(path, token, req.body ?? {}, expected));
      }
    }
    router.get('/tenant-users', tenantUsers);
    router.post('/tenant-users', tenantUsers);
    router.patch('/tenant-users/:userId/status', tenantUsers);
  }

  async function scopedFeed(req: Request, res: Response) {
    const token = authenticated(req, res);
    if (!token) return;
    const expected = req.get('X-AIOps-Expected-Tenant');
    if (!expected || !UUID_PATTERN.test(expected)) {
      res.status(422).json({ error: 'Identificador de tenant inválido.' });
      return;
    }
    const query = queryFor(req, ['after', 'limit']);
    const resource = req.params.feed;
    if (resource && !FEEDS.has(resource)) {
      res.status(404).json({ error: 'Consulta indisponível.' });
      return;
    }
    const path = resource ? '/inventory/feed/' + resource : '/inventory/audit';
    forward(res, await callCore(path + query, token, undefined, expected));
  }
  router.get('/inventory/audit', scopedFeed);
  router.get('/inventory/feed/:feed', scopedFeed);

  async function incident(req: Request, res: Response) {
    const token = authenticated(req, res);
    if (!token) return;
    const expected = req.get('X-AIOps-Expected-Tenant');
    const id = req.params.id;
    if (!expected || !UUID_PATTERN.test(expected) || !UUID_PATTERN.test(id)) {
      res.status(422).json({ error: 'Identificador de incidente ou tenant inválido.' });
      return;
    }
    const path = '/inventory/incidents/' + id;
    if (req.method === 'PATCH') {
      forward(res, await callCore(path + '/rca-review', token, req.body ?? {}, expected, 'PATCH'));
    } else {
      forward(res, await callCore(path + queryFor(req, ['after', 'limit']), token, undefined, expected));
    }
  }
  router.get('/inventory/incidents/:id', incident);
  if (incidentWrites) router.patch('/inventory/incidents/:id/rca-review', incident);

  if (connectorWrites) {
    const connectorIngest = (suffix = '') => async (req: Request, res: Response) => {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      const id = req.params.id;
      if (!expected || !UUID_PATTERN.test(expected) || (id && !UUID_PATTERN.test(id))) {
        res.status(422).json({ error: 'Identificador de conector ou tenant inválido.' });
        return;
      }
      const action = id ? '/' + id + '/ingest' + suffix : '';
      forward(res, await callCore('/inventory/connectors' + action, token, req.body ?? {}, expected));
    };
    router.post('/inventory/connectors', connectorIngest());
    router.post('/inventory/connectors/:id/ingest', connectorIngest());
    router.post('/inventory/connectors/:id/ingest/metrics', connectorIngest('/metrics'));
    router.post('/inventory/connectors/:id/ingest/logs', connectorIngest('/logs'));

    router.post('/inventory/connectors/open-meteo', async (req, res) => {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      if (!expected || !UUID_PATTERN.test(expected)) {
        res.status(422).json({ error: 'Identificador de tenant inválido.' });
        return;
      }
      forward(res, await callCore('/inventory/connectors/open-meteo', token, req.body ?? {}, expected));
    });

    const weather = (operation: 'sync' | 'disable' | 'schedule') => async (req: Request, res: Response) => {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      const id = req.params.id;
      if (!expected || !UUID_PATTERN.test(expected) || !UUID_PATTERN.test(id)) {
        res.status(422).json({ error: 'Identificador de conector ou tenant inválido.' });
        return;
      }
      const path = '/inventory/connectors/' + id + '/open-meteo/';
      if (operation !== 'sync') {
        const body = req.method === 'POST' ? (operation === 'schedule' ? req.body ?? {} : {}) : undefined;
        forward(res, await callCore(path + operation, token, body, expected));
        return;
      }
      const target = await callCore(path + 'begin', token, {}, expected);
      if (target.status !== 200) {
        forward(res, target);
        return;
      }
      const result = await getOpenMeteoCurrent(target.body.latitude, target.body.longitude);
      forward(res, await callCore(path + 'finish', token, { run_id: target.body.run_id, ...result }, expected));
    };
    router.post('/inventory/connectors/:id/open-meteo/sync', weather('sync'));
    router.post('/inventory/connectors/:id/open-meteo/disable', weather('disable'));
    router.get('/inventory/connectors/:id/open-meteo/schedule', weather('schedule'));
    router.post('/inventory/connectors/:id/open-meteo/schedule', weather('schedule'));
  }

  if (itsm) {
    async function incidentTickets(req: Request, res: Response) {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      if (!expected || !UUID_PATTERN.test(expected) || !UUID_PATTERN.test(req.params.id)) {
        res.status(422).json({ error: 'Identificador de incidente ou tenant inválido.' });
        return;
      }
      const body = req.method === 'POST' ? req.body ?? {} : undefined;
      forward(res, await callCore('/inventory/incidents/' + req.params.id + '/itsm/tickets', token, body, expected));
    }
    router.get('/inventory/incidents/:id/itsm/tickets', incidentTickets);
    if (incidentWrites) router.post('/inventory/incidents/:id/itsm/tickets', incidentTickets);
  }

  router.get('/inventory/sites/map', async (req, res) => {
    const token = authenticated(req, res);
    if (token) {
      const query = queryFor(req, ['north', 'south', 'west', 'east', 'after', 'limit']);
      forward(res, await callCore('/inventory/sites/map' + query, token));
    }
  });

  type WritableResource = 'sites' | 'assets' | 'services' | 'concessions' | 'locality-types' | 'asset-categories';

  function writeInventory(resource: WritableResource, suffix: '' | '/verify-coords' = '') {
    return async (req: Request, res: Response) => {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      const id = req.params.id;
      if (!expected || !UUID_PATTERN.test(expected) || (id && !UUID_PATTERN.test(id))) {
        res.status(422).json({ error: 'Identificador de inventário ou tenant inválido.' });
        return;
      }
      const base = '/inventory/' + resource;
      const path = id ? base + '/' + id + suffix : base;
      const removing = req.method === 'DELETE';
      forward(res, await callCore(path, token, removing ? undefined : req.body ?? {}, expected,
        removing ? 'DELETE' : id ? 'PATCH' : undefined));
    };
  }

  if (siteWrites) {
    const cepLimit = new SlidingWindowRateLimiter(30, 60_000);
    const geocodeLimit = new SlidingWindowRateLimiter(1, 1000);

    async function authorizeGeography(req: Request, res: Response) {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      if (!expected || !UUID_PATTERN.test(expected)) {
        res.status(422).json({ error: 'Identificador de tenant inválido.' });
        return;
      }
      const result = await callCore('/auth/me', token);
      if (result.status !== 200) {
        forward(res, result);
        return;
      }
      if (result.body.active_tenant_id !== expected) {
        res.status(409).json({ error: 'Selecione ou confirme o tenant ativo.' });
        return;
      }
      if (!['super_admin', 'tenant_admin', 'tenant_operator'].includes(result.body.role)) {
        res.status(403).json({ error: 'Permissão insuficiente para consultar endereços de sites.' });
        return;
      }
      return expected;
    }

    router.get('/geo/cep/:cep', async (req, res) => {
      const tenant = await authorizeGeography(req, res);
      if (!tenant) return;
      const cep = req.params.cep;
      if (!/^\d{5}-?\d{3}$/.test(cep)) {
        res.status(422).json({ error: 'Informe um CEP com oito dígitos.' });
        return;
      }
      if (!cepLimit.check(tenant).allowed) {
        res.status(429).json({ error: 'Limite de consultas de CEP atingido.' });
        return;
      }
      try {
        const { lookupCepAddress } = await import('./integrations.ts');
        res.json(await lookupCepAddress(cep));
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const missing = message === 'CEP não encontrado na base oficial.';
        res.status(missing ? 404 : 502).json({ error: missing ? message : 'Consulta de CEP indisponível.' });
      }
    });

    router.post('/geo/geocode', async (req, res) => {
      if (!await authorizeGeography(req, res)) return;
      const { address = '', municipality, uf } = req.body ?? {};
      if (typeof address !== 'string' || address.length > 400 || typeof municipality !== 'string'
        || !municipality.trim() || municipality.length > 200 || typeof uf !== 'string' || !/^[A-Za-z]{2}$/.test(uf)) {
        res.status(422).json({ error: 'Informe município e UF válidos para localizar o site.' });
        return;
      }
      if (!geocodeLimit.check('nominatim').allowed) {
        res.status(429).json({ error: 'Consultas de coordenadas muito frequentes. Tente novamente.' });
        return;
      }
      try {
        const { geocodeAddressNominatim } = await import('./integrations.ts');
        const point = await geocodeAddressNominatim({ address: address.trim(), municipality: municipality.trim(), uf });
        if (!point || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180) {
          res.status(404).json({ error: 'Endereço não localizado. Informe as coordenadas manualmente.' });
          return;
        }
        res.json(point);
      } catch {
        res.status(502).json({ error: 'Serviço de geocodificação indisponível.' });
      }
    });

    router.post('/inventory/concessions', writeInventory('concessions'));
    router.delete('/inventory/concessions/:id', writeInventory('concessions'));
    router.post('/inventory/locality-types', writeInventory('locality-types'));
    router.post('/inventory/sites', writeInventory('sites'));
    router.patch('/inventory/sites/:id', writeInventory('sites'));
    router.delete('/inventory/sites/:id', writeInventory('sites'));
    router.patch('/inventory/sites/:id/verify-coords', writeInventory('sites', '/verify-coords'));
  }
  if (assetWrites) {
    router.post('/inventory/asset-categories', writeInventory('asset-categories'));
    router.post('/inventory/assets', writeInventory('assets'));
    router.patch('/inventory/assets/:id', writeInventory('assets'));
    router.delete('/inventory/assets/:id', writeInventory('assets'));
  }

  if (serviceWrites) {
    router.post('/inventory/services', writeInventory('services'));
    router.patch('/inventory/services/:id', writeInventory('services'));
    router.delete('/inventory/services/:id', writeInventory('services'));
  }

  const topologyEdges = '/inventory/topology/edges';
  router.get(topologyEdges, async (req, res) => {
    const token = authenticated(req, res);
    if (token) forward(res, await callCore(topologyEdges + queryFor(req, ['after', 'limit']), token));
  });

  if (assetWrites) {
    async function mutateTopology(req: Request, res: Response) {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      const id = req.params.edgeId;
      if (!expected || !UUID_PATTERN.test(expected) || (id && !UUID_PATTERN.test(id))) {
        res.status(422).json({ error: 'Identificador de enlace ou tenant inválido.' });
        return;
      }
      if (id) forward(res, await callCore(topologyEdges + '/' + id, token, undefined, expected, 'DELETE'));
      else forward(res, await callCore(topologyEdges, token, req.body ?? {}, expected));
    }
    router.post(topologyEdges, mutateTopology);
    router.delete(topologyEdges + '/:edgeId', mutateTopology);
  }

  function dependencyPath(req: Request, res: Response): string | undefined {
    const { serviceId, dependencyId } = req.params;
    if (!UUID_PATTERN.test(serviceId) || (dependencyId && !UUID_PATTERN.test(dependencyId))) {
      res.status(422).json({ error: 'Identificador de serviço ou dependência inválido.' });
      return;
    }
    const base = '/inventory/services/' + serviceId + '/dependencies';
    return dependencyId ? base + '/' + dependencyId : base;
  }

  router.get('/inventory/services/:serviceId/dependencies', async (req, res) => {
    const token = authenticated(req, res);
    if (!token) return;
    const path = dependencyPath(req, res);
    if (path) forward(res, await callCore(path + queryFor(req, ['after', 'limit']), token));
  });

  if (serviceWrites) {
    async function mutateDependency(req: Request, res: Response) {
      const token = authenticated(req, res);
      if (!token) return;
      const expected = req.get('X-AIOps-Expected-Tenant');
      if (!expected || !UUID_PATTERN.test(expected)) {
        res.status(422).json({ error: 'Identificador de tenant inválido.' });
        return;
      }
      const path = dependencyPath(req, res);
      if (!path) return;
      const removing = req.method === 'DELETE';
      forward(res, await callCore(path, token, removing ? undefined : req.body ?? {}, expected,
        removing ? 'DELETE' : undefined));
    }
    router.post('/inventory/services/:serviceId/dependencies', mutateDependency);
    router.delete('/inventory/services/:serviceId/dependencies/:dependencyId', mutateDependency);
  }

  router.get('/inventory/:resource', async (req, res) => {
    const token = authenticated(req, res);
    if (!token) return;
    if (!INVENTORY.has(req.params.resource)) {
      res.status(404).json({ error: 'Recurso indisponível neste console.' });
      return;
    }
    forward(res, await callCore('/inventory/' + req.params.resource + queryFor(req, ['after', 'limit']), token));
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'Rota indisponível neste console.' });
  });
  return router;
}
