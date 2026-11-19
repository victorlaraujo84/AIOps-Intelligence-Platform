import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';
import { initializeTenantTaxonomy, openDatabase, writeAuditLog } from './db.ts';
import {
  geocodeAddressNominatim,
  ingestCanonicalEvents,
  lookupCepAddress,
  syncOpenMeteoForTenant,
  testConnectorConnectivity,
  type ConnectorRow,
  type IngestEventInput,
} from './integrations.ts';
import {
  encryptCredentials,
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  SlidingWindowRateLimiter,
  validateExternalUrl,
  verifyPassword,
} from './security.ts';
import { findSharedUpstreamDependencies, wouldCreateTopologyCycle } from './topology.ts';
import type { AuthUser, RcaCategory, Role } from '../shared/types.ts';

interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
  sessionId?: string;
  resolvedTenantId?: string | null;
}

const SESSION_COOKIE_NAME = 'aiops_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    result[key] = val;
  }
  return result;
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function getSessionCookieOptions(req: Request) {
  const proto = req.headers['x-forwarded-proto'];
  const isHttps = req.secure || (typeof proto === 'string' && proto.split(',')[0].trim() === 'https');
  return {
    httpOnly: true,
    sameSite: (isHttps ? 'none' : 'lax') as 'none' | 'lax',
    secure: isHttps,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

function isWriteAllowed(role: Role): boolean {
  return role === 'super_admin' || role === 'tenant_admin' || role === 'tenant_operator';
}

function isAdminRole(role: Role): boolean {
  return role === 'super_admin' || role === 'tenant_admin';
}

export function createApp(options: { dbPath?: string; db?: Database.Database } = {}) {
  const db = options.db ?? openDatabase(options.dbPath ?? process.env.SQLITE_DB_PATH ?? './data/aiops.db');
  const app = express();

  const authRateLimiter = new SlidingWindowRateLimiter(30, 15 * 60 * 1000);
  const connectorTestLimiter = new SlidingWindowRateLimiter(30, 5 * 60 * 1000);

  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Cabeçalhos básicos de segurança
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Health / Readiness checks (sem vazar segredos ou dados de tenants)
  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ status: 'ok', service: 'aiops-web-api', db: 'connected', timestamp_utc: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'error' });
    }
  });

  // Middleware de autenticação
  function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const cookies = parseCookies(req.headers.cookie);
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
    const rawToken = bearerToken || cookies[SESSION_COOKIE_NAME];

    if (!rawToken) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }

    const tokenHash = hashSessionToken(rawToken);
    const row = db
      .prepare(
        `SELECT s.id AS session_id, s.active_tenant_id, s.expires_at_utc,
                u.id, u.tenant_id, u.email, u.full_name, u.role, u.is_active, u.created_at_utc, u.last_login_utc
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as
      | {
          session_id: string;
          active_tenant_id: string | null;
          expires_at_utc: string;
          id: string;
          tenant_id: string | null;
          email: string;
          full_name: string;
          role: Role;
          is_active: number;
          created_at_utc: string;
          last_login_utc: string | null;
        }
      | undefined;

    if (!row || !row.is_active || new Date(row.expires_at_utc).getTime() <= Date.now()) {
      if (row?.session_id) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id);
      }
      res.status(401).json({ error: 'Sessão inválida ou expirada.' });
      return;
    }

    const effectiveTenantId = row.role === 'super_admin' ? row.active_tenant_id : row.tenant_id;

    req.sessionId = row.session_id;
    req.authUser = {
      id: row.id,
      tenant_id: row.tenant_id,
      active_tenant_id: effectiveTenantId,
      email: row.email,
      full_name: row.full_name,
      role: row.role,
      is_active: Boolean(row.is_active),
      created_at_utc: row.created_at_utc,
      last_login_utc: row.last_login_utc,
    };
    req.resolvedTenantId = effectiveTenantId;
    next();
  }

  // Middleware que exige contexto de tenant ativo e rejeita tentativas de acesso cruzado
  function requireTenantContext(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    const user = req.authUser;
    if (!user) {
      res.status(401).json({ error: 'Não autenticado.' });
      return;
    }

    const requestedTenantParam =
      (req.query.tenant_id as string | undefined) ||
      (req.headers['x-tenant-id'] as string | undefined) ||
      (req.body && typeof req.body === 'object' && 'tenant_id' in req.body ? String(req.body.tenant_id) : undefined);

    // Usuários vinculados a tenant NUNCA podem especificar outro tenant_id
    if (user.role !== 'super_admin') {
      if (requestedTenantParam && requestedTenantParam !== user.tenant_id) {
        writeAuditLog(db, {
          tenant_id: user.tenant_id,
          actor_user_id: user.id,
          actor_email: user.email,
          actor_role: user.role,
          action: 'CROSS_TENANT_ACCESS_DENIED',
          resource_type: 'tenant',
          resource_id: requestedTenantParam,
          details: { path: req.path, method: req.method },
          ip_address: getClientIp(req),
        });
        res.status(403).json({ error: 'Acesso negado: violação de isolamento multi-tenant.' });
        return;
      }
      if (!user.tenant_id) {
        res.status(403).json({ error: 'Usuário sem tenant associado.' });
        return;
      }
      req.resolvedTenantId = user.tenant_id;
      next();
      return;
    }

    // super_admin precisa ter selecionado um tenant ativo (ou estar em rota explícita de tenants)
    if (!req.resolvedTenantId) {
      res.status(400).json({ error: 'Nenhum tenant ativo selecionado para esta operação.' });
      return;
    }
    next();
  }

  // ==================== AUTHENTICATION ====================

  app.get('/api/auth/status', (_req, res) => {
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
    res.json({ bootstrap_required: count === 0 });
  });

  app.post('/api/auth/bootstrap', (req, res) => {
    const count = (db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number }).cnt;
    if (count > 0) {
      res.status(403).json({ error: 'Bootstrap já concluído. Use o login padrão.' });
      return;
    }

    const { email, full_name, password, initial_tenant_name, initial_tenant_slug } = req.body ?? {};
    if (!email || !full_name || !password || String(password).length < 8) {
      res.status(400).json({ error: 'Informe nome completo, e-mail válido e senha com no mínimo 8 caracteres.' });
      return;
    }

    const now = new Date().toISOString();
    const userId = crypto.randomUUID();
    const normalizedEmail = String(email).trim().toLowerCase();
    const passwordHash = hashPassword(String(password));

    let createdTenantId: string | null = null;

    const trx = db.transaction(() => {
      if (initial_tenant_name && String(initial_tenant_name).trim().length > 0) {
        const tId = crypto.randomUUID();
        const slug = (initial_tenant_slug || String(initial_tenant_name))
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        db.prepare(
          `INSERT INTO tenants (id, name, slug, status, created_at_utc, updated_at_utc) VALUES (?, ?, ?, 'active', ?, ?)`,
        ).run(tId, String(initial_tenant_name).trim(), slug || `tenant-${tId.slice(0, 6)}`, now, now);
        initializeTenantTaxonomy(db, tId);
        createdTenantId = tId;
      }

      db.prepare(
        `INSERT INTO users (id, tenant_id, email, full_name, role, password_hash, is_active, created_at_utc, last_login_utc)
         VALUES (?, NULL, ?, ?, 'super_admin', ?, 1, ?, ?)`,
      ).run(userId, normalizedEmail, String(full_name).trim(), passwordHash, now, now);

      writeAuditLog(db, {
        tenant_id: createdTenantId,
        actor_user_id: userId,
        actor_email: normalizedEmail,
        actor_role: 'super_admin',
        action: 'SYSTEM_BOOTSTRAP_SUPER_ADMIN',
        resource_type: 'user',
        resource_id: userId,
        details: { initial_tenant_id: createdTenantId },
        ip_address: getClientIp(req),
      });
    });

    trx();

    const token = generateSessionToken();
    const sessionId = crypto.randomUUID();
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    db.prepare(
      `INSERT INTO sessions (id, user_id, active_tenant_id, token_hash, expires_at_utc, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, userId, createdTenantId, hashSessionToken(token), expires, now);

    res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(req));

    res.status(201).json({
      token,
      user: {
        id: userId,
        tenant_id: null,
        active_tenant_id: createdTenantId,
        email: normalizedEmail,
        full_name: String(full_name).trim(),
        role: 'super_admin',
        is_active: true,
        created_at_utc: now,
        last_login_utc: now,
      },
    });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = getClientIp(req);
    const rate = authRateLimiter.check(`login:${ip}`);
    if (!rate.allowed) {
      res.status(429).json({ error: 'Muitas tentativas de autenticação. Aguarde alguns minutos.' });
      return;
    }

    const { email, password } = req.body ?? {};
    if (!email || !password) {
      res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const userRow = db
      .prepare(
        `SELECT id, tenant_id, email, full_name, role, password_hash, is_active, created_at_utc, last_login_utc
         FROM users WHERE email = ?`,
      )
      .get(normalizedEmail) as
      | {
          id: string;
          tenant_id: string | null;
          email: string;
          full_name: string;
          role: Role;
          password_hash: string;
          is_active: number;
          created_at_utc: string;
          last_login_utc: string | null;
        }
      | undefined;

    if (!userRow || !userRow.is_active || !verifyPassword(String(password), userRow.password_hash)) {
      writeAuditLog(db, {
        tenant_id: userRow?.tenant_id ?? null,
        actor_user_id: userRow?.id ?? null,
        actor_email: normalizedEmail,
        actor_role: userRow?.role ?? null,
        action: 'AUTH_LOGIN_FAILED',
        resource_type: 'session',
        ip_address: ip,
      });
      res.status(401).json({ error: 'Credenciais inválidas.' });
      return;
    }

    let activeTenantId = userRow.tenant_id;
    if (userRow.role === 'super_admin' && !activeTenantId) {
      const firstTenant = db.prepare(`SELECT id FROM tenants ORDER BY created_at_utc ASC LIMIT 1`).get() as
        | { id: string }
        | undefined;
      activeTenantId = firstTenant?.id ?? null;
    }

    const now = new Date().toISOString();
    const token = generateSessionToken();
    const sessionId = crypto.randomUUID();
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();

    db.prepare(`UPDATE users SET last_login_utc = ? WHERE id = ?`).run(now, userRow.id);
    db.prepare(
      `INSERT INTO sessions (id, user_id, active_tenant_id, token_hash, expires_at_utc, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(sessionId, userRow.id, activeTenantId, hashSessionToken(token), expires, now);

    writeAuditLog(db, {
      tenant_id: activeTenantId,
      actor_user_id: userRow.id,
      actor_email: userRow.email,
      actor_role: userRow.role,
      action: 'AUTH_LOGIN_SUCCESS',
      resource_type: 'session',
      resource_id: sessionId,
      ip_address: ip,
    });

    res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(req));

    res.json({
      token,
      user: {
        id: userRow.id,
        tenant_id: userRow.tenant_id,
        active_tenant_id: activeTenantId,
        email: userRow.email,
        full_name: userRow.full_name,
        role: userRow.role,
        is_active: Boolean(userRow.is_active),
        created_at_utc: userRow.created_at_utc,
        last_login_utc: now,
      },
    });
  });

  app.post('/api/auth/logout', authenticate, (req: AuthenticatedRequest, res) => {
    if (req.sessionId) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
    }
    const opts = getSessionCookieOptions(req);
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: opts.httpOnly,
      sameSite: opts.sameSite,
      secure: opts.secure,
      path: opts.path,
    });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', authenticate, (req: AuthenticatedRequest, res) => {
    res.json({ user: req.authUser });
  });

  app.post('/api/auth/switch-tenant', authenticate, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'super_admin') {
      res.status(403).json({ error: 'Apenas super_admin pode alternar entre tenants.' });
      return;
    }

    const { tenant_id } = req.body ?? {};
    if (!tenant_id) {
      res.status(400).json({ error: 'tenant_id obrigatório.' });
      return;
    }

    const tenant = db.prepare('SELECT id, name, slug FROM tenants WHERE id = ?').get(String(tenant_id)) as
      | { id: string; name: string; slug: string }
      | undefined;
    if (!tenant) {
      res.status(404).json({ error: 'Tenant não encontrado.' });
      return;
    }

    db.prepare('UPDATE sessions SET active_tenant_id = ? WHERE id = ?').run(tenant.id, req.sessionId);
    writeAuditLog(db, {
      tenant_id: tenant.id,
      actor_user_id: user.id,
      actor_email: user.email,
      actor_role: user.role,
      action: 'SUPER_ADMIN_TENANT_SWITCH',
      resource_type: 'tenant',
      resource_id: tenant.id,
      details: { target_tenant_name: tenant.name, target_tenant_slug: tenant.slug },
      ip_address: getClientIp(req),
    });

    res.json({
      active_tenant_id: tenant.id,
      tenant,
      user: {
        ...user,
        active_tenant_id: tenant.id,
      },
    });
  });

  // ==================== TENANTS & RBAC ====================

  app.get('/api/tenants', authenticate, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'super_admin') {
      const tenants = db.prepare('SELECT * FROM tenants ORDER BY created_at_utc ASC').all();
      res.json({ tenants });
      return;
    }
    const ownTenant = db.prepare('SELECT * FROM tenants WHERE id = ?').all(user.tenant_id);
    res.json({ tenants: ownTenant });
  });

  app.post('/api/tenants', authenticate, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (user.role !== 'super_admin') {
      res.status(403).json({ error: 'Apenas super_admin pode criar novos tenants.' });
      return;
    }

    const { name, slug, document } = req.body ?? {};
    if (!name || String(name).trim().length < 2) {
      res.status(400).json({ error: 'Nome do tenant obrigatório.' });
      return;
    }

    const cleanSlug = (slug ? String(slug) : String(name))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    if (!cleanSlug) {
      res.status(400).json({ error: 'Slug inválido.' });
      return;
    }

    const existing = db.prepare('SELECT id FROM tenants WHERE slug = ?').get(cleanSlug);
    if (existing) {
      res.status(409).json({ error: 'Já existe um tenant com este slug.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    const trx = db.transaction(() => {
      db.prepare(
        `INSERT INTO tenants (id, name, slug, document, status, created_at_utc, updated_at_utc)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      ).run(id, String(name).trim(), cleanSlug, document ? String(document).trim() : null, now, now);

      initializeTenantTaxonomy(db, id);

      // Se o super_admin ainda não tinha tenant ativo na sessão, seleciona o primeiro criado
      if (!user.active_tenant_id && req.sessionId) {
        db.prepare('UPDATE sessions SET active_tenant_id = ? WHERE id = ?').run(id, req.sessionId);
      }

      writeAuditLog(db, {
        tenant_id: id,
        actor_user_id: user.id,
        actor_email: user.email,
        actor_role: user.role,
        action: 'TENANT_CREATED',
        resource_type: 'tenant',
        resource_id: id,
        details: { name: String(name).trim(), slug: cleanSlug },
        ip_address: getClientIp(req),
      });
    });

    trx();
    const created = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
    res.status(201).json({ tenant: created });
  });

  app.get('/api/users', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (!isAdminRole(user.role)) {
      res.status(403).json({ error: 'Acesso restrito a administradores.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const rows = db
      .prepare(
        `SELECT id, tenant_id, email, full_name, role, is_active, created_at_utc, last_login_utc
         FROM users WHERE tenant_id = ? ORDER BY created_at_utc DESC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;

    res.json({ users: rows.map((r) => ({ ...r, is_active: Boolean(r.is_active) })) });
  });

  app.post('/api/users', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem criar usuários.' });
      return;
    }

    const { email, full_name, password, role } = req.body ?? {};
    const requestedRole = String(role || 'tenant_viewer') as Role;

    if (!['super_admin', 'tenant_admin', 'tenant_operator', 'tenant_viewer'].includes(requestedRole)) {
      res.status(400).json({ error: 'Papel RBAC inválido.' });
      return;
    }

    if (requestedRole === 'super_admin' && actor.role !== 'super_admin') {
      res.status(403).json({ error: 'Apenas super_admin pode criar outro super_admin.' });
      return;
    }

    if (!email || !full_name || !password || String(password).length < 8) {
      res.status(400).json({ error: 'Informe e-mail, nome completo e senha com mínimo de 8 caracteres.' });
      return;
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    if (db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail)) {
      res.status(409).json({ error: 'Já existe um usuário com este e-mail.' });
      return;
    }

    const targetTenantId = requestedRole === 'super_admin' ? null : req.resolvedTenantId!;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO users (id, tenant_id, email, full_name, role, password_hash, is_active, created_at_utc)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, targetTenantId, normalizedEmail, String(full_name).trim(), requestedRole, hashPassword(String(password)), now);

    writeAuditLog(db, {
      tenant_id: targetTenantId ?? req.resolvedTenantId ?? null,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'USER_CREATED',
      resource_type: 'user',
      resource_id: id,
      details: { email: normalizedEmail, role: requestedRole },
      ip_address: getClientIp(req),
    });

    res.status(201).json({
      user: {
        id,
        tenant_id: targetTenantId,
        email: normalizedEmail,
        full_name: String(full_name).trim(),
        role: requestedRole,
        is_active: true,
        created_at_utc: now,
        last_login_utc: null,
      },
    });
  });

  app.patch('/api/users/:id/toggle', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem alterar status de usuários.' });
      return;
    }
    const target = db.prepare('SELECT id, tenant_id, is_active, email FROM users WHERE id = ?').get(req.params.id) as
      | { id: string; tenant_id: string | null; is_active: number; email: string }
      | undefined;

    if (!target || target.tenant_id !== req.resolvedTenantId) {
      res.status(404).json({ error: 'Usuário não encontrado neste tenant.' });
      return;
    }
    if (target.id === actor.id) {
      res.status(400).json({ error: 'Não é possível desativar o próprio usuário autenticado.' });
      return;
    }

    const nextActive = target.is_active ? 0 : 1;
    db.prepare('UPDATE users SET is_active = ? WHERE id = ? AND tenant_id = ?').run(
      nextActive,
      target.id,
      req.resolvedTenantId!,
    );
    writeAuditLog(db, {
      tenant_id: req.resolvedTenantId!,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: nextActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED',
      resource_type: 'user',
      resource_id: target.id,
      details: { email: target.email },
      ip_address: getClientIp(req),
    });
    res.json({ id: target.id, is_active: Boolean(nextActive) });
  });

  // ==================== CONCESSIONS & TAXONOMIES ====================

  app.get('/api/concessions', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare('SELECT * FROM concessions WHERE tenant_id = ? ORDER BY name ASC')
      .all(req.resolvedTenantId!);
    res.json({ concessions: rows });
  });

  app.post('/api/concessions', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const { name, code, region, description } = req.body ?? {};
    if (!name || !code) {
      res.status(400).json({ error: 'Nome e código da concessão/unidade são obrigatórios.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const cleanCode = String(code).trim().toUpperCase();
    if (db.prepare('SELECT id FROM concessions WHERE tenant_id = ? AND code = ?').get(tenantId, cleanCode)) {
      res.status(409).json({ error: 'Código de concessão já existe neste tenant.' });
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO concessions (id, tenant_id, name, code, region, description, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, String(name).trim(), cleanCode, region ? String(region).trim() : null, description ?? null, now);

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'CONCESSION_CREATED',
      resource_type: 'concession',
      resource_id: id,
      details: { code: cleanCode, name },
      ip_address: getClientIp(req),
    });

    res.status(201).json({ concession: db.prepare('SELECT * FROM concessions WHERE id = ?').get(id) });
  });

  app.delete('/api/concessions/:id', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem excluir concessões.' });
      return;
    }
    const info = db
      .prepare('DELETE FROM concessions WHERE id = ? AND tenant_id = ?')
      .run(req.params.id, req.resolvedTenantId!);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Concessão não encontrada neste tenant.' });
      return;
    }
    writeAuditLog(db, {
      tenant_id: req.resolvedTenantId!,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'CONCESSION_DELETED',
      resource_type: 'concession',
      resource_id: req.params.id,
      ip_address: getClientIp(req),
    });
    res.json({ deleted: true });
  });

  app.get('/api/locality-types', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare('SELECT * FROM locality_types WHERE tenant_id = ? ORDER BY code ASC')
      .all(req.resolvedTenantId!);
    res.json({ locality_types: rows });
  });

  app.post('/api/locality-types', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const { code, label, description } = req.body ?? {};
    if (!code || !label) {
      res.status(400).json({ error: 'Código e rótulo do tipo de localidade são obrigatórios.' });
      return;
    }
    const cleanCode = String(code).trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const tenantId = req.resolvedTenantId!;
    if (db.prepare('SELECT id FROM locality_types WHERE tenant_id = ? AND code = ?').get(tenantId, cleanCode)) {
      res.status(409).json({ error: 'Tipo de localidade já cadastrado neste tenant.' });
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO locality_types (id, tenant_id, code, label, description, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, cleanCode, String(label).trim(), description ?? null, now);
    res.status(201).json({ locality_type: db.prepare('SELECT * FROM locality_types WHERE id = ?').get(id) });
  });

  app.get('/api/asset-categories', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const rows = db
      .prepare('SELECT * FROM asset_categories WHERE tenant_id = ? ORDER BY domain ASC, code ASC')
      .all(req.resolvedTenantId!);
    res.json({ asset_categories: rows });
  });

  app.post('/api/asset-categories', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const { code, label, domain } = req.body ?? {};
    if (!code || !label || !['rede', 'energia', 'infra', 'sensor'].includes(String(domain))) {
      res.status(400).json({ error: 'Código, rótulo e domínio válido (rede|energia|infra|sensor) são obrigatórios.' });
      return;
    }
    const cleanCode = String(code).trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const tenantId = req.resolvedTenantId!;
    if (db.prepare('SELECT id FROM asset_categories WHERE tenant_id = ? AND code = ?').get(tenantId, cleanCode)) {
      res.status(409).json({ error: 'Categoria de ativo já existe neste tenant.' });
      return;
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO asset_categories (id, tenant_id, code, label, domain, created_at_utc) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, tenantId, cleanCode, String(label).trim(), String(domain), now);
    res.status(201).json({ asset_category: db.prepare('SELECT * FROM asset_categories WHERE id = ?').get(id) });
  });

  // ==================== GEO / CEP ====================

  app.get('/api/geo/cep/:cep', authenticate, async (req, res) => {
    try {
      const result = await lookupCepAddress(req.params.cep);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Erro ao consultar CEP.' });
    }
  });

  app.post('/api/geo/geocode', authenticate, async (req, res) => {
    const { address, municipality, uf } = req.body ?? {};
    if (!municipality || !uf) {
      res.status(400).json({ error: 'Município e UF são obrigatórios para geocodificação.' });
      return;
    }
    try {
      const result = await geocodeAddressNominatim({ address, municipality, uf });
      if (!result) {
        res.status(404).json({ error: 'Endereço não localizado no geocodificador. Informe as coordenadas manualmente.' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Falha no serviço de geocodificação.' });
    }
  });

  // ==================== SITES ====================

  app.get('/api/sites', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const rows = db
      .prepare(
        `SELECT s.*, c.name AS concession_name, lt.code AS locality_type_code, lt.label AS locality_type_label
         FROM sites s
         LEFT JOIN concessions c ON c.id = s.concession_id AND c.tenant_id = s.tenant_id
         LEFT JOIN locality_types lt ON lt.id = s.locality_type_id AND lt.tenant_id = s.tenant_id
         WHERE s.tenant_id = ?
         ORDER BY s.name ASC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;

    res.json({ sites: rows.map((r) => ({ ...r, coord_verified: Boolean(r.coord_verified) })) });
  });

  app.post('/api/sites', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente para cadastrar sites.' });
      return;
    }

    const tenantId = req.resolvedTenantId!;
    const {
      concession_id,
      locality_type_id,
      code,
      name,
      address,
      cep,
      municipality,
      uf,
      latitude,
      longitude,
      coord_precision,
      coord_verified,
      criticality,
    } = req.body ?? {};

    if (!code || !name) {
      res.status(400).json({ error: 'Código e nome do site são obrigatórios.' });
      return;
    }

    const cleanCode = String(code).trim().toUpperCase();
    if (db.prepare('SELECT id FROM sites WHERE tenant_id = ? AND code = ?').get(tenantId, cleanCode)) {
      res.status(409).json({ error: 'Já existe um site com este código neste tenant.' });
      return;
    }

    if (concession_id && !db.prepare('SELECT id FROM concessions WHERE id = ? AND tenant_id = ?').get(concession_id, tenantId)) {
      res.status(400).json({ error: 'Concessão informada não pertence a este tenant.' });
      return;
    }

    const hasLat = latitude !== undefined && latitude !== null && latitude !== '';
    const hasLon = longitude !== undefined && longitude !== null && longitude !== '';
    const numLat = hasLat ? Number(latitude) : null;
    const numLon = hasLon ? Number(longitude) : null;

    if ((numLat !== null && (Number.isNaN(numLat) || numLat < -90 || numLat > 90)) ||
        (numLon !== null && (Number.isNaN(numLon) || numLon < -180 || numLon > 180))) {
      res.status(400).json({ error: 'Latitude/Longitude fora da faixa geográfica válida.' });
      return;
    }

    const hasCoords = numLat !== null && numLon !== null;
    const verified = hasCoords && Boolean(coord_verified);
    const precision = hasCoords
      ? coord_precision === 'manual_verificada' || coord_precision === 'geocodificada'
        ? coord_precision
        : verified
          ? 'manual_verificada'
          : 'geocodificada'
      : 'pendente';

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO sites (
        id, tenant_id, concession_id, locality_type_id, code, name, address, cep,
        municipality, uf, latitude, longitude, coord_precision, coord_verified,
        criticality, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      tenantId,
      concession_id || null,
      locality_type_id || null,
      cleanCode,
      String(name).trim(),
      address ? String(address).trim() : null,
      cep ? String(cep).replace(/\D/g, '') : null,
      municipality ? String(municipality).trim() : null,
      uf ? String(uf).trim().toUpperCase().slice(0, 2) : null,
      numLat,
      numLon,
      precision,
      verified ? 1 : 0,
      ['critica', 'alta', 'media', 'baixa'].includes(String(criticality)) ? String(criticality) : 'media',
      now,
      now,
    );

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'SITE_CREATED',
      resource_type: 'site',
      resource_id: id,
      details: { code: cleanCode, name, coord_verified: verified, coord_precision: precision },
      ip_address: getClientIp(req),
    });

    const created = db
      .prepare(
        `SELECT s.*, c.name AS concession_name, lt.code AS locality_type_code, lt.label AS locality_type_label
         FROM sites s
         LEFT JOIN concessions c ON c.id = s.concession_id
         LEFT JOIN locality_types lt ON lt.id = s.locality_type_id
         WHERE s.id = ?`,
      )
      .get(id) as Record<string, unknown>;

    res.status(201).json({ site: { ...created, coord_verified: Boolean(created.coord_verified) } });
  });

  app.patch('/api/sites/:id/verify-coords', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const { latitude, longitude } = req.body ?? {};
    const numLat = Number(latitude);
    const numLon = Number(longitude);
    if (!Number.isFinite(numLat) || !Number.isFinite(numLon) || numLat < -90 || numLat > 90 || numLon < -180 || numLon > 180) {
      res.status(400).json({ error: 'Coordenadas inválidas.' });
      return;
    }
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `UPDATE sites SET latitude = ?, longitude = ?, coord_precision = 'manual_verificada', coord_verified = 1, updated_at_utc = ?
         WHERE id = ? AND tenant_id = ?`,
      )
      .run(numLat, numLon, now, req.params.id, tenantId);

    if (info.changes === 0) {
      res.status(404).json({ error: 'Site não encontrado neste tenant.' });
      return;
    }
    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'SITE_COORDS_VERIFIED',
      resource_type: 'site',
      resource_id: req.params.id,
      details: { latitude: numLat, longitude: numLon },
      ip_address: getClientIp(req),
    });
    res.json({ verified: true, latitude: numLat, longitude: numLon });
  });

  app.delete('/api/sites/:id', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem remover sites.' });
      return;
    }
    const info = db.prepare('DELETE FROM sites WHERE id = ? AND tenant_id = ?').run(req.params.id, req.resolvedTenantId!);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Site não encontrado neste tenant.' });
      return;
    }
    writeAuditLog(db, {
      tenant_id: req.resolvedTenantId!,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'SITE_DELETED',
      resource_type: 'site',
      resource_id: req.params.id,
      ip_address: getClientIp(req),
    });
    res.json({ deleted: true });
  });

  // ==================== ASSETS & TOPOLOGY ====================

  app.get('/api/assets', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const rows = db
      .prepare(
        `SELECT a.*, s.name AS site_name, s.code AS site_code,
                ac.code AS category_code, ac.label AS category_label
         FROM assets a
         JOIN sites s ON s.id = a.site_id AND s.tenant_id = a.tenant_id
         LEFT JOIN asset_categories ac ON ac.id = a.category_id AND ac.tenant_id = a.tenant_id
         WHERE a.tenant_id = ?
         ORDER BY s.code ASC, a.name ASC`,
      )
      .all(tenantId);
    res.json({ assets: rows });
  });

  app.post('/api/assets', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente para cadastrar ativos.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const {
      site_id,
      category_id,
      name,
      hostname,
      ip_address,
      vendor,
      model,
      provider_name,
      redundancy_group,
      topology_parent_id,
      criticality,
    } = req.body ?? {};

    if (!site_id || !name) {
      res.status(400).json({ error: 'Site e nome do ativo são obrigatórios.' });
      return;
    }

    if (!db.prepare('SELECT id FROM sites WHERE id = ? AND tenant_id = ?').get(site_id, tenantId)) {
      res.status(400).json({ error: 'Site informado não pertence a este tenant.' });
      return;
    }

    if (
      topology_parent_id &&
      !db.prepare('SELECT id FROM assets WHERE id = ? AND tenant_id = ?').get(topology_parent_id, tenantId)
    ) {
      res.status(400).json({ error: 'Ativo pai de topologia não pertence a este tenant.' });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO assets (
        id, tenant_id, site_id, category_id, name, hostname, ip_address,
        vendor, model, provider_name, redundancy_group, topology_parent_id,
        criticality, operational_state, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NO_DATA', ?, ?)`,
    ).run(
      id,
      tenantId,
      site_id,
      category_id || null,
      String(name).trim(),
      hostname ? String(hostname).trim() : null,
      ip_address ? String(ip_address).trim() : null,
      vendor ? String(vendor).trim() : null,
      model ? String(model).trim() : null,
      provider_name ? String(provider_name).trim() : null,
      redundancy_group ? String(redundancy_group).trim() : null,
      topology_parent_id || null,
      ['critica', 'alta', 'media', 'baixa'].includes(String(criticality)) ? String(criticality) : 'media',
      now,
      now,
    );

    if (topology_parent_id) {
      db.prepare(
        `INSERT OR IGNORE INTO topology_edges (
          id, tenant_id, source_asset_id, target_asset_id, link_type, provider_name, is_redundant, created_at_utc
        ) VALUES (?, ?, ?, ?, 'parent_fallback', ?, 0, ?)`,
      ).run(crypto.randomUUID(), tenantId, topology_parent_id, id, provider_name ?? null, now);
    }

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'ASSET_CREATED',
      resource_type: 'asset',
      resource_id: id,
      details: { name, site_id },
      ip_address: getClientIp(req),
    });

    const created = db
      .prepare(
        `SELECT a.*, s.name AS site_name, s.code AS site_code,
                ac.code AS category_code, ac.label AS category_label
         FROM assets a
         JOIN sites s ON s.id = a.site_id
         LEFT JOIN asset_categories ac ON ac.id = a.category_id
         WHERE a.id = ?`,
      )
      .get(id);

    res.status(201).json({ asset: created });
  });

  app.delete('/api/assets/:id', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem excluir ativos.' });
      return;
    }
    const info = db.prepare('DELETE FROM assets WHERE id = ? AND tenant_id = ?').run(req.params.id, req.resolvedTenantId!);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Ativo não encontrado neste tenant.' });
      return;
    }
    res.json({ deleted: true });
  });

  app.get('/api/topology/edges', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const edges = db
      .prepare(
        `SELECT e.*,
                sa.name AS source_asset_name, sa.site_id AS source_site_id,
                ta.name AS target_asset_name, ta.site_id AS target_site_id
         FROM topology_edges e
         JOIN assets sa ON sa.id = e.source_asset_id AND sa.tenant_id = e.tenant_id
         JOIN assets ta ON ta.id = e.target_asset_id AND ta.tenant_id = e.tenant_id
         WHERE e.tenant_id = ?
         ORDER BY e.created_at_utc DESC`,
      )
      .all(tenantId) as Array<{
      id: string;
      source_asset_id: string;
      target_asset_id: string;
      is_redundant: number;
    }>;

    const sharedDependencies = findSharedUpstreamDependencies(edges);
    res.json({
      edges: edges.map((e) => ({ ...e, is_redundant: Boolean(e.is_redundant) })),
      shared_upstream_dependencies: sharedDependencies,
    });
  });

  app.post('/api/topology/edges', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const { source_asset_id, target_asset_id, link_type, provider_name, capacity_mbps, is_redundant } = req.body ?? {};

    if (!source_asset_id || !target_asset_id || !link_type) {
      res.status(400).json({ error: 'Ativo de origem (upstream), destino (downstream) e tipo de enlace são obrigatórios.' });
      return;
    }

    const src = db.prepare('SELECT id FROM assets WHERE id = ? AND tenant_id = ?').get(source_asset_id, tenantId);
    const dst = db.prepare('SELECT id FROM assets WHERE id = ? AND tenant_id = ?').get(target_asset_id, tenantId);
    if (!src || !dst) {
      res.status(400).json({ error: 'Ativos informados não pertencem a este tenant.' });
      return;
    }

    const existingEdges = db
      .prepare('SELECT source_asset_id, target_asset_id FROM topology_edges WHERE tenant_id = ?')
      .all(tenantId) as Array<{ source_asset_id: string; target_asset_id: string }>;

    if (wouldCreateTopologyCycle(existingEdges, String(source_asset_id), String(target_asset_id))) {
      res.status(400).json({
        error: 'Enlace rejeitado: criaria um ciclo topológico inválido no grafo de dependências.',
      });
      return;
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO topology_edges (
          id, tenant_id, source_asset_id, target_asset_id, link_type, provider_name, capacity_mbps, is_redundant, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        tenantId,
        source_asset_id,
        target_asset_id,
        String(link_type).trim(),
        provider_name ? String(provider_name).trim() : null,
        capacity_mbps ? Number(capacity_mbps) : null,
        is_redundant ? 1 : 0,
        now,
      );
    } catch {
      res.status(409).json({ error: 'Este enlace topológico já está cadastrado.' });
      return;
    }

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'TOPOLOGY_EDGE_CREATED',
      resource_type: 'topology_edge',
      resource_id: id,
      details: { source_asset_id, target_asset_id, link_type },
      ip_address: getClientIp(req),
    });

    res.status(201).json({ edge: db.prepare('SELECT * FROM topology_edges WHERE id = ?').get(id) });
  });

  app.delete('/api/topology/edges/:id', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const info = db
      .prepare('DELETE FROM topology_edges WHERE id = ? AND tenant_id = ?')
      .run(req.params.id, req.resolvedTenantId!);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Enlace não encontrado.' });
      return;
    }
    res.json({ deleted: true });
  });

  // ==================== INTEGRATIONS & EVENTS ====================

  app.get('/api/integrations/connectors', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const rows = db
      .prepare('SELECT * FROM connectors WHERE tenant_id = ? ORDER BY created_at_utc DESC')
      .all(tenantId) as Array<ConnectorRow & { poll_interval_sec: number; status: string; last_sync_at_utc: string | null; last_error: string | null; created_at_utc: string; updated_at_utc: string }>;

    const runs = db
      .prepare(
        `SELECT r.*, c.name AS connector_name
         FROM connector_sync_runs r
         JOIN connectors c ON c.id = r.connector_id
         WHERE r.tenant_id = ?
         ORDER BY r.started_at_utc DESC
         LIMIT 50`,
      )
      .all(tenantId);

    res.json({
      connectors: rows.map((r) => ({
        id: r.id,
        tenant_id: r.tenant_id,
        connector_type: r.connector_type,
        name: r.name,
        endpoint_url: r.endpoint_url,
        auth_mode: r.auth_mode,
        has_credentials: Boolean(r.encrypted_credentials),
        config_json: JSON.parse(r.config_json || '{}'),
        poll_interval_sec: r.poll_interval_sec,
        status: r.status,
        last_sync_at_utc: r.last_sync_at_utc,
        last_error: r.last_error,
        created_at_utc: r.created_at_utc,
        updated_at_utc: r.updated_at_utc,
      })),
      sync_runs: runs,
    });
  });

  app.post('/api/integrations/connectors', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem configurar conectores.' });
      return;
    }

    const tenantId = req.resolvedTenantId!;
    const { connector_type, name, endpoint_url, auth_mode, credentials, poll_interval_sec, config_json } = req.body ?? {};
    const validTypes = ['open_meteo', 'inmet', 'cemaden', 'zabbix', 'prtg', 'snmp_trap', 'energy_ups', 'webhook_csv'];
    if (!validTypes.includes(String(connector_type)) || !name) {
      res.status(400).json({ error: 'Tipo de conector válido e nome são obrigatórios.' });
      return;
    }

    if (endpoint_url) {
      const ssrf = validateExternalUrl(String(endpoint_url));
      if (!ssrf.ok) {
        res.status(400).json({ error: ssrf.reason });
        return;
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const encCreds = credentials ? encryptCredentials(String(credentials)) : null;
    const initialStatus =
      connector_type === 'open_meteo' || connector_type === 'webhook_csv' || endpoint_url ? 'CONFIGURED' : 'NOT_CONFIGURED';

    db.prepare(
      `INSERT INTO connectors (
        id, tenant_id, connector_type, name, endpoint_url, auth_mode,
        encrypted_credentials, config_json, poll_interval_sec, status, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      tenantId,
      String(connector_type),
      String(name).trim(),
      endpoint_url ? String(endpoint_url).trim() : null,
      ['none', 'api_key', 'bearer', 'basic'].includes(String(auth_mode)) ? String(auth_mode) : 'none',
      encCreds,
      JSON.stringify(config_json && typeof config_json === 'object' ? config_json : {}),
      Math.max(60, Number(poll_interval_sec || 300)),
      initialStatus,
      now,
      now,
    );

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'CONNECTOR_CREATED',
      resource_type: 'connector',
      resource_id: id,
      details: { connector_type, name, has_credentials: Boolean(encCreds) },
      ip_address: getClientIp(req),
    });

    res.status(201).json({ id, status: initialStatus });
  });

  app.post('/api/integrations/connectors/:id/test', authenticate, requireTenantContext, async (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const rate = connectorTestLimiter.check(`conn:${req.resolvedTenantId}`);
    if (!rate.allowed) {
      res.status(429).json({ error: 'Limite de testes de conector atingido. Aguarde alguns minutos.' });
      return;
    }

    const row = db
      .prepare('SELECT * FROM connectors WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, req.resolvedTenantId!) as ConnectorRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'Conector não encontrado neste tenant.' });
      return;
    }

    const result = await testConnectorConnectivity(row);
    const now = new Date().toISOString();
    const nextStatus = result.ok ? 'HEALTHY' : row.endpoint_url || row.connector_type === 'open_meteo' ? 'ERROR' : 'NOT_CONFIGURED';

    db.prepare('UPDATE connectors SET status = ?, last_error = ?, updated_at_utc = ? WHERE id = ? AND tenant_id = ?').run(
      nextStatus,
      result.ok ? null : result.detail,
      now,
      row.id,
      req.resolvedTenantId!,
    );

    writeAuditLog(db, {
      tenant_id: req.resolvedTenantId!,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'CONNECTOR_TESTED',
      resource_type: 'connector',
      resource_id: row.id,
      details: { ok: result.ok, latency_ms: result.latency_ms, status_code: result.status_code ?? null },
      ip_address: getClientIp(req),
    });

    res.json({ ...result, connector_status: nextStatus });
  });

  app.post('/api/integrations/connectors/:id/sync', authenticate, requireTenantContext, async (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const row = db
      .prepare('SELECT * FROM connectors WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId) as ConnectorRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'Conector não encontrado neste tenant.' });
      return;
    }

    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    if (row.connector_type === 'open_meteo') {
      const outcome = await syncOpenMeteoForTenant(db, tenantId, row.id);
      const finishedAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO connector_sync_runs (
          id, tenant_id, connector_id, started_at_utc, finished_at_utc, status,
          records_ingested, records_deduplicated, latency_ms, error_message, raw_metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        runId,
        tenantId,
        row.id,
        startedAt,
        finishedAt,
        outcome.status,
        outcome.records_ingested,
        outcome.records_deduplicated,
        outcome.latency_ms,
        outcome.error_message,
        JSON.stringify({ source: 'open_meteo' }),
      );

      db.prepare(
        `UPDATE connectors SET status = ?, last_sync_at_utc = ?, last_error = ?, updated_at_utc = ? WHERE id = ? AND tenant_id = ?`,
      ).run(
        outcome.status === 'ERROR' ? 'ERROR' : 'HEALTHY',
        finishedAt,
        outcome.error_message,
        finishedAt,
        row.id,
        tenantId,
      );

      res.json({ run_id: runId, ...outcome });
      return;
    }

    const finishedAt = new Date().toISOString();
    const msg =
      row.connector_type === 'webhook_csv'
        ? 'Conectores webhook_csv recebem dados via POST /ingest ou importação de arquivo.'
        : `Sincronização ativa de ${row.connector_type} requer worker Python/credenciais reais em execução (services/ingestion).`;

    db.prepare(
      `INSERT INTO connector_sync_runs (
        id, tenant_id, connector_id, started_at_utc, finished_at_utc, status,
        records_ingested, records_deduplicated, latency_ms, error_message, raw_metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'ERROR', 0, 0, 0, ?, '{}')`,
    ).run(runId, tenantId, row.id, startedAt, finishedAt, msg);

    res.status(400).json({ error: msg, run_id: runId });
  });

  app.post('/api/integrations/connectors/:id/ingest', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const row = db
      .prepare('SELECT * FROM connectors WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId) as ConnectorRow | undefined;

    if (!row) {
      res.status(404).json({ error: 'Conector não encontrado neste tenant.' });
      return;
    }

    const events = req.body?.events as IngestEventInput[] | undefined;
    if (!Array.isArray(events) || events.length === 0) {
      res.status(400).json({ error: 'Informe um array não vazio em "events".' });
      return;
    }

    for (const ev of events) {
      if (!ev.idempotency_key || !ev.event_time_utc || !ev.observed_at_utc || !ev.source || !ev.event_type || !ev.status) {
        res.status(400).json({
          error:
            'Cada evento deve cumprir o contrato canônico: idempotency_key, event_time_utc, observed_at_utc, source, event_type e status.',
        });
        return;
      }
    }

    const startedAt = new Date().toISOString();
    const result = ingestCanonicalEvents(db, tenantId, row.id, events);
    const finishedAt = new Date().toISOString();
    const runId = crypto.randomUUID();

    db.prepare(
      `INSERT INTO connector_sync_runs (
        id, tenant_id, connector_id, started_at_utc, finished_at_utc, status,
        records_ingested, records_deduplicated, latency_ms, error_message, raw_metadata_json
      ) VALUES (?, ?, ?, ?, ?, 'SUCCESS', ?, ?, 0, NULL, ?)`,
    ).run(
      runId,
      tenantId,
      row.id,
      startedAt,
      finishedAt,
      result.ingested,
      result.deduplicated,
      JSON.stringify({ mode: 'authenticated_ingest', created_incidents: result.created_incidents }),
    );

    db.prepare(`UPDATE connectors SET status = 'HEALTHY', last_sync_at_utc = ?, last_error = NULL, updated_at_utc = ? WHERE id = ?`).run(
      finishedAt,
      finishedAt,
      row.id,
    );

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'EVENTS_INGESTED',
      resource_type: 'connector',
      resource_id: row.id,
      details: result,
      ip_address: getClientIp(req),
    });

    res.status(201).json({ run_id: runId, ...result });
  });

  app.delete('/api/integrations/connectors/:id', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem excluir conectores.' });
      return;
    }
    const info = db
      .prepare('DELETE FROM connectors WHERE id = ? AND tenant_id = ?')
      .run(req.params.id, req.resolvedTenantId!);
    if (info.changes === 0) {
      res.status(404).json({ error: 'Conector não encontrado.' });
      return;
    }
    res.json({ deleted: true });
  });

  // ==================== EVENTS & INCIDENTS / RCA ====================

  app.get('/api/events', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const rows = db
      .prepare(
        `SELECT e.*, s.code AS site_code, a.name AS asset_name
         FROM canonical_events e
         LEFT JOIN sites s ON s.id = e.site_id AND s.tenant_id = e.tenant_id
         LEFT JOIN assets a ON a.id = e.asset_id AND a.tenant_id = e.tenant_id
         WHERE e.tenant_id = ?
         ORDER BY e.observed_at_utc DESC
         LIMIT 100`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;

    res.json({
      events: rows.map((r) => ({ ...r, payload_json: JSON.parse(String(r.payload_json || '{}')) })),
    });
  });

  app.get('/api/incidents', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const rows = db
      .prepare(
        `SELECT i.*, s.name AS root_site_name, a.name AS root_asset_name,
                (SELECT COUNT(*) FROM incident_events ie WHERE ie.incident_id = i.id AND ie.tenant_id = i.tenant_id) AS event_count
         FROM incidents i
         LEFT JOIN sites s ON s.id = i.root_site_id
         LEFT JOIN assets a ON a.id = i.root_asset_id
         WHERE i.tenant_id = ?
         ORDER BY i.opened_at_utc DESC
         LIMIT 100`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;

    res.json({
      incidents: rows.map((r) => ({
        ...r,
        rca_evidence: JSON.parse(String(r.rca_evidence_json || '[]')),
      })),
    });
  });

  app.patch('/api/incidents/:id/rca-review', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isWriteAllowed(actor.role)) {
      res.status(403).json({ error: 'Permissão insuficiente para revisar RCA.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const { rca_category, status, review_note } = req.body ?? {};
    const validCategories: RcaCategory[] = ['eletrica', 'climatica_direta', 'composta', 'telecom_outros', 'desconhecida'];
    if (rca_category && !validCategories.includes(rca_category)) {
      res.status(400).json({ error: 'Categoria de RCA inválida.' });
      return;
    }

    const existing = db
      .prepare('SELECT * FROM incidents WHERE id = ? AND tenant_id = ?')
      .get(req.params.id, tenantId) as
      | { id: string; status: string; rca_category: string; rca_evidence_json: string; resolved_at_utc: string | null }
      | undefined;

    if (!existing) {
      res.status(404).json({ error: 'Incidente não encontrado neste tenant.' });
      return;
    }

    const now = new Date().toISOString();
    const evidence = JSON.parse(existing.rca_evidence_json || '[]') as string[];
    if (review_note) {
      evidence.push(`Revisão humana (${actor.email} em ${now}): ${String(review_note).trim()}`);
    }

    const nextStatus = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'].includes(String(status)) ? String(status) : existing.status;
    const nextCategory = rca_category ?? existing.rca_category;
    const resolvedAt = nextStatus === 'RESOLVED' ? existing.resolved_at_utc ?? now : null;

    db.prepare(
      `UPDATE incidents
       SET rca_category = ?, status = ?, rca_evidence_json = ?, human_reviewed_by = ?, human_reviewed_at_utc = ?, resolved_at_utc = ?
       WHERE id = ? AND tenant_id = ?`,
    ).run(nextCategory, nextStatus, JSON.stringify(evidence), actor.id, now, resolvedAt, existing.id, tenantId);

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'INCIDENT_RCA_REVIEWED',
      resource_type: 'incident',
      resource_id: existing.id,
      details: { rca_category: nextCategory, status: nextStatus },
      ip_address: getClientIp(req),
    });

    res.json({ updated: true, rca_category: nextCategory, status: nextStatus });
  });

  // ==================== NOC OVERVIEW & ML HONEST STATES ====================

  app.get('/api/noc/overview', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) as Record<string, unknown> | undefined;

    const sitesTotal = (db.prepare('SELECT COUNT(*) AS c FROM sites WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const sitesVerified = (
      db.prepare('SELECT COUNT(*) AS c FROM sites WHERE tenant_id = ? AND coord_verified = 1').get(tenantId) as { c: number }
    ).c;
    const assetsTotal = (db.prepare('SELECT COUNT(*) AS c FROM assets WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const edgesTotal = (db.prepare('SELECT COUNT(*) AS c FROM topology_edges WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const connectorsTotal = (db.prepare('SELECT COUNT(*) AS c FROM connectors WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const connectorsHealthy = (
      db.prepare("SELECT COUNT(*) AS c FROM connectors WHERE tenant_id = ? AND status = 'HEALTHY'").get(tenantId) as { c: number }
    ).c;
    const connectorsError = (
      db.prepare("SELECT COUNT(*) AS c FROM connectors WHERE tenant_id = ? AND status = 'ERROR'").get(tenantId) as { c: number }
    ).c;

    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const events24h = (
      db
        .prepare('SELECT COUNT(*) AS c FROM canonical_events WHERE tenant_id = ? AND observed_at_utc >= ?')
        .get(tenantId, cutoff24h) as { c: number }
    ).c;
    const eventsTotal = (db.prepare('SELECT COUNT(*) AS c FROM canonical_events WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const incidentsOpen = (
      db.prepare("SELECT COUNT(*) AS c FROM incidents WHERE tenant_id = ? AND status != 'RESOLVED'").get(tenantId) as { c: number }
    ).c;
    const incidentsTotal = (db.prepare('SELECT COUNT(*) AS c FROM incidents WHERE tenant_id = ?').get(tenantId) as { c: number }).c;

    const telemetryStatus =
      connectorsTotal === 0
        ? 'NOT_CONFIGURED'
        : eventsTotal === 0
          ? 'NO_DATA'
          : events24h === 0
            ? 'SOURCE_STALE'
            : 'ACTIVE';

    const incidentsStatus = incidentsTotal === 0 ? 'NO_DATA' : 'ACTIVE';

    res.json({
      tenant: tenant ?? null,
      metrics: {
        sites_total: sitesTotal,
        sites_verified_coords: sitesVerified,
        sites_pending_coords: sitesTotal - sitesVerified,
        assets_total: assetsTotal,
        topology_edges_total: edgesTotal,
        connectors_total: connectorsTotal,
        connectors_healthy: connectorsHealthy,
        connectors_error: connectorsError,
        events_24h: events24h,
        incidents_open: incidentsOpen,
      },
      honest_states: {
        telemetry_status: telemetryStatus,
        incidents_status: incidentsStatus,
        ml_status: 'MODEL_NOT_VALIDATED',
        prediction_status: 'PREDICTION_UNAVAILABLE',
        backtest_status: eventsTotal < 100 ? 'INSUFFICIENT_DATA' : 'MODEL_NOT_VALIDATED',
      },
      provenance: {
        tenant_id: tenantId,
        window: '24h_utc_rolling',
        computed_at_utc: new Date().toISOString(),
        source: 'sqlite_authoritative_store',
      },
    });
  });

  app.get('/api/ml/status', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const eventCount = (db.prepare('SELECT COUNT(*) AS c FROM canonical_events WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const incidentCount = (db.prepare('SELECT COUNT(*) AS c FROM incidents WHERE tenant_id = ?').get(tenantId) as { c: number }).c;

    res.json({
      tenant_id: tenantId,
      model_status: 'MODEL_NOT_VALIDATED',
      prediction_status: 'PREDICTION_UNAVAILABLE',
      backtest_status: eventCount < 100 ? 'INSUFFICIENT_DATA' : 'MODEL_NOT_VALIDATED',
      shadow_mode_enforced: true,
      dataset_summary: {
        canonical_events_count: eventCount,
        incidents_count: incidentCount,
        minimum_events_recommended_for_split: 100,
      },
      candidate_models: [
        { code: 'A_BASE_RATE', name: 'Prevalência / Base Rate por Tenant e Região', status: 'MODEL_NOT_VALIDATED' },
        { code: 'B_OPERATIONAL_RULES', name: 'Regras Operacionais Determinísticas', status: 'MODEL_NOT_VALIDATED' },
        { code: 'C_LOGISTIC_REGRESSION', name: 'Regressão Logística Calibrada', status: 'MODEL_NOT_VALIDATED' },
        { code: 'D_LIGHTGBM', name: 'LightGBM Local (Horizontes 1h/3h/6h)', status: 'MODEL_NOT_VALIDATED' },
        { code: 'E_XGBOOST', name: 'XGBoost Local (Horizontes 1h/3h/6h)', status: 'MODEL_NOT_VALIDATED' },
      ],
      ablations: ['Rede', 'Rede + Energia', 'Rede + Energia + Clima'],
      execution_note:
        'Treinamento local (LightGBM/XGBoost/SHAP) e backtesting cronológico anti-leakage residem nos serviços Python (services/ml-engine e backtesting/) para execução com séries históricas reais.',
    });
  });

  // ==================== AI AGENT CONFIG ====================

  app.get('/api/ai-agent/config', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const tenantId = req.resolvedTenantId!;
    const row = db.prepare('SELECT * FROM ai_agent_configs WHERE tenant_id = ?').get(tenantId) as
      | {
          tenant_id: string;
          mode: 'offline' | 'openai' | 'ollama';
          endpoint_url: string | null;
          encrypted_api_key: string | null;
          model_name: string | null;
          data_sharing_authorized: number;
          timeout_ms: number;
          updated_by: string | null;
          updated_at_utc: string;
        }
      | undefined;

    res.json({
      config: row
        ? {
            tenant_id: row.tenant_id,
            mode: row.mode,
            endpoint_url: row.endpoint_url,
            has_api_key: Boolean(row.encrypted_api_key),
            model_name: row.model_name,
            data_sharing_authorized: Boolean(row.data_sharing_authorized),
            timeout_ms: row.timeout_ms,
            updated_by: row.updated_by,
            updated_at_utc: row.updated_at_utc,
          }
        : {
            tenant_id: tenantId,
            mode: 'offline',
            endpoint_url: null,
            has_api_key: false,
            model_name: null,
            data_sharing_authorized: false,
            timeout_ms: 15000,
            updated_by: null,
            updated_at_utc: null,
          },
    });
  });

  app.put('/api/ai-agent/config', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    if (!isAdminRole(actor.role)) {
      res.status(403).json({ error: 'Apenas administradores podem configurar o Agente de IA.' });
      return;
    }
    const tenantId = req.resolvedTenantId!;
    const { mode, endpoint_url, api_key, model_name, data_sharing_authorized, timeout_ms } = req.body ?? {};

    if (!['offline', 'openai', 'ollama'].includes(String(mode))) {
      res.status(400).json({ error: 'Modo inválido. Escolha offline, openai ou ollama.' });
      return;
    }

    if (mode === 'openai' && !data_sharing_authorized) {
      res.status(400).json({
        error: 'É obrigatório autorizar explicitamente o compartilhamento de dados antes de ativar o provedor OpenAI.',
      });
      return;
    }

    if (endpoint_url && mode !== 'offline') {
      const ssrf = validateExternalUrl(String(endpoint_url));
      if (!ssrf.ok && mode !== 'ollama') {
        res.status(400).json({ error: ssrf.reason });
        return;
      }
    }

    const existing = db.prepare('SELECT encrypted_api_key FROM ai_agent_configs WHERE tenant_id = ?').get(tenantId) as
      | { encrypted_api_key: string | null }
      | undefined;
    const encKey = api_key ? encryptCredentials(String(api_key)) : existing?.encrypted_api_key ?? null;
    const now = new Date().toISOString();

    db.prepare(
      `INSERT INTO ai_agent_configs (
        tenant_id, mode, endpoint_url, encrypted_api_key, model_name, data_sharing_authorized, timeout_ms, updated_by, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id) DO UPDATE SET
        mode = excluded.mode,
        endpoint_url = excluded.endpoint_url,
        encrypted_api_key = excluded.encrypted_api_key,
        model_name = excluded.model_name,
        data_sharing_authorized = excluded.data_sharing_authorized,
        timeout_ms = excluded.timeout_ms,
        updated_by = excluded.updated_by,
        updated_at_utc = excluded.updated_at_utc`,
    ).run(
      tenantId,
      String(mode),
      endpoint_url ? String(endpoint_url).trim() : null,
      encKey,
      model_name ? String(model_name).trim() : null,
      data_sharing_authorized ? 1 : 0,
      Math.min(60000, Math.max(1000, Number(timeout_ms || 15000))),
      actor.id,
      now,
    );

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'AI_AGENT_CONFIG_UPDATED',
      resource_type: 'ai_agent_config',
      resource_id: tenantId,
      details: { mode, data_sharing_authorized: Boolean(data_sharing_authorized), model_name: model_name ?? null },
      ip_address: getClientIp(req),
    });

    res.json({ updated: true });
  });

  // ==================== AUDIT LOGS & TENANT REPORTS ====================

  app.get('/api/audit-logs', authenticate, (req: AuthenticatedRequest, res) => {
    const user = req.authUser!;
    if (user.role === 'super_admin' && !req.resolvedTenantId) {
      const rows = db.prepare('SELECT * FROM audit_logs ORDER BY created_at_utc DESC LIMIT 100').all() as Array<Record<string, unknown>>;
      res.json({ logs: rows.map((r) => ({ ...r, details_json: JSON.parse(String(r.details_json || '{}')) })) });
      return;
    }

    const tenantId = user.role === 'super_admin' ? req.resolvedTenantId! : user.tenant_id!;
    const rows = db
      .prepare('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at_utc DESC LIMIT 100')
      .all(tenantId) as Array<Record<string, unknown>>;
    res.json({ logs: rows.map((r) => ({ ...r, details_json: JSON.parse(String(r.details_json || '{}')) })) });
  });

  app.get('/api/reports/export', authenticate, requireTenantContext, (req: AuthenticatedRequest, res) => {
    const actor = req.authUser!;
    const tenantId = req.resolvedTenantId!;
    const format = String(req.query.format || 'json').toLowerCase();

    const tenant = db.prepare('SELECT id, name, slug, status FROM tenants WHERE id = ?').get(tenantId) as {
      id: string;
      name: string;
      slug: string;
      status: string;
    };
    const sites = db.prepare('SELECT code, name, municipality, uf, latitude, longitude, coord_precision, coord_verified, criticality FROM sites WHERE tenant_id = ? ORDER BY code ASC').all(tenantId) as Array<Record<string, unknown>>;
    const assets = db.prepare('SELECT name, hostname, ip_address, operational_state, criticality FROM assets WHERE tenant_id = ?').all(tenantId) as Array<Record<string, unknown>>;
    const connectors = db.prepare('SELECT connector_type, name, status, last_sync_at_utc, last_error FROM connectors WHERE tenant_id = ?').all(tenantId) as Array<Record<string, unknown>>;
    const eventsCount = (db.prepare('SELECT COUNT(*) AS c FROM canonical_events WHERE tenant_id = ?').get(tenantId) as { c: number }).c;
    const incidentsCount = (db.prepare('SELECT COUNT(*) AS c FROM incidents WHERE tenant_id = ?').get(tenantId) as { c: number }).c;

    writeAuditLog(db, {
      tenant_id: tenantId,
      actor_user_id: actor.id,
      actor_email: actor.email,
      actor_role: actor.role,
      action: 'TENANT_REPORT_EXPORTED',
      resource_type: 'report',
      resource_id: tenantId,
      details: { format },
      ip_address: getClientIp(req),
    });

    if (format === 'csv') {
      const header = 'code,name,municipality,uf,latitude,longitude,coord_precision,coord_verified,criticality';
      const lines = sites.map((s) =>
        [
          s.code,
          `"${String(s.name ?? '').replace(/"/g, '""')}"`,
          `"${String(s.municipality ?? '').replace(/"/g, '""')}"`,
          s.uf ?? '',
          s.latitude ?? '',
          s.longitude ?? '',
          s.coord_precision ?? '',
          s.coord_verified ? 'true' : 'false',
          s.criticality ?? '',
        ].join(','),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="sites-${tenant.slug}.csv"`);
      res.send([header, ...lines].join('\n'));
      return;
    }

    if (format === 'markdown') {
      const now = new Date().toISOString();
      const md = [
        `# Relatório Operacional e Governança — ${tenant.name}`,
        `- **Tenant ID:** \`${tenant.id}\``,
        `- **Gerado em (UTC):** \`${now}\``,
        `- **Gerado por:** ${actor.email} (${actor.role})`,
        ``,
        `## 1. Inventário Real`,
        `- Sites cadastrados: ${sites.length}`,
        `- Sites com coordenadas verificadas: ${sites.filter((s) => Boolean(s.coord_verified)).length}`,
        `- Ativos cadastrados: ${assets.length}`,
        `- Conectores configurados: ${connectors.length}`,
        `- Eventos canônicos ingeridos: ${eventsCount}`,
        `- Incidentes registrados: ${incidentsCount}`,
        ``,
        `## 2. Governança de Modelos e Decisão`,
        `- **Status de ML:** \`MODEL_NOT_VALIDATED\``,
        `- **Status de Predição:** \`PREDICTION_UNAVAILABLE\``,
        `- **Decisão atual de promoção:** \`NO-GO\` (aguardando série histórica real, backtesting cronológico sem vazamento e aprovação humana do NOC).`,
      ].join('\n');
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="validation-report-${tenant.slug}.md"`);
      res.send(md);
      return;
    }

    res.json({
      exported_at_utc: new Date().toISOString(),
      tenant,
      inventory: { sites, assets, connectors },
      telemetry_counts: { canonical_events: eventsCount, incidents: incidentsCount },
      ml_governance: { status: 'MODEL_NOT_VALIDATED', decision: 'NO-GO' },
    });
  });

  // Garante 404 JSON para rotas /api/* desconhecidas
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint de API não encontrado.' });
  });

  return { app, db };
}
