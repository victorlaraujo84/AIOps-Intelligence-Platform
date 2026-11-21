import { Router, type CookieOptions, type Request, type Response } from 'express';
import { SlidingWindowRateLimiter } from './security.ts';

const COOKIE_NAME = '__Host-aiops_pg_session';
const COOKIE_OPTIONS: CookieOptions = { httpOnly: true, secure: true, sameSite: 'strict', path: '/' };
const API = 'http://api:8000/api/v1';
const SESSION_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const INVENTORY = new Set(['sites', 'assets', 'services', 'asset-categories', 'concessions', 'locality-types']);

function sessionToken(req: Request): string | undefined {
  const token = req.headers.cookie?.split(';')
    .map(cookie => cookie.trim())
    .find(cookie => cookie.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);
  return token && SESSION_PATTERN.test(token) ? token : undefined;
}

async function callCore(path: string, token?: string, payload?: object) {
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (payload) headers.set('Content-Type', 'application/json');
  try {
    const upstream = await fetch(API + path, {
      headers,
      method: payload ? 'POST' : 'GET',
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

export function postgresConsoleRouter(enabled: boolean, pilotOnly: boolean): Router {
  const router = Router();
  const limiter = new SlidingWindowRateLimiter(30, 15 * 60 * 1000);

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!enabled) {
      res.status(404).json({ error: 'Console PostgreSQL indisponível.' });
      return;
    }
    if (req.method === 'POST' && (!req.is('application/json') || req.get('sec-fetch-site') === 'cross-site')) {
      res.status(403).json({ error: 'Envie a operação pelo console de homologação.' });
      return;
    }
    next();
  });

  router.get('/status', (_req, res) => {
    res.json({ enabled: true, pilot_only: pilotOnly });
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

  router.get('/inventory/sites/map', async (req, res) => {
    const token = authenticated(req, res);
    if (token) {
      const query = queryFor(req, ['north', 'south', 'west', 'east', 'after', 'limit']);
      forward(res, await callCore('/inventory/sites/map' + query, token));
    }
  });

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
