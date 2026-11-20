import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

interface RuntimeSecrets {
  sessionSecret: string;
  credKeyHex: string;
}

let cachedRuntimeSecrets: RuntimeSecrets | null = null;

function loadOrCreateRuntimeSecrets(): RuntimeSecrets {
  if (cachedRuntimeSecrets) return cachedRuntimeSecrets;

  const secretsPath = path.resolve(process.cwd(), 'data', '.runtime_secrets.json');
  try {
    if (fs.existsSync(secretsPath)) {
      const parsed = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as Partial<RuntimeSecrets>;
      if (parsed.sessionSecret && parsed.credKeyHex) {
        cachedRuntimeSecrets = {
          sessionSecret: parsed.sessionSecret,
          credKeyHex: parsed.credKeyHex,
        };
        return cachedRuntimeSecrets;
      }
    }
  } catch {
    // Recria arquivo em caso de leitura inválida
  }

  const generated: RuntimeSecrets = {
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    credKeyHex: crypto.randomBytes(32).toString('hex'),
  };

  try {
    fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
    fs.writeFileSync(secretsPath, JSON.stringify(generated, null, 2), { mode: 0o600 });
  } catch {
    // Em ambientes read-only mantém apenas em memória
  }

  cachedRuntimeSecrets = generated;
  return generated;
}

function isConfiguredSecret(value: string | undefined, minBytes: number): value is string {
  return Boolean(value && Buffer.byteLength(value.trim()) >= minBytes && !value.trim().startsWith('CHANGE_ME'));
}

function getConfiguredEncryptionKey(): Buffer | undefined {
  const configured = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (configured?.startsWith('hex:')) {
    const hex = configured.slice(4);
    return /^[a-f0-9]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : undefined;
  }
  const minBytes = process.env.NODE_ENV === 'production' ? 32 : 16;
  if (isConfiguredSecret(configured, minBytes)) {
    return crypto.createHash('sha256').update(configured).digest();
  }
}

export function validateProductionSecrets(): void {
  if (process.env.NODE_ENV !== 'production') return;
  if (!isConfiguredSecret(process.env.AUTH_SESSION_SECRET, 32)) {
    throw new Error('AUTH_SESSION_SECRET deve ter pelo menos 32 bytes em produção.');
  }
  if (!getConfiguredEncryptionKey()) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY deve ter pelo menos 32 bytes ou usar hex:<64 dígitos> em produção.');
  }
}

export function getBootstrapToken(): string | undefined {
  const token = process.env.AIOPS_BOOTSTRAP_TOKEN;
  if (isConfiguredSecret(token, 32)) return token;
  if (token) throw new Error('AIOPS_BOOTSTRAP_TOKEN deve ter pelo menos 32 bytes.');
}

function getSessionSecret(): string {
  const configured = process.env.AUTH_SESSION_SECRET;
  if (isConfiguredSecret(configured, 32)) {
    return configured;
  }
  return loadOrCreateRuntimeSecrets().sessionSecret;
}

function getEncryptionKey(): Buffer {
  return getConfiguredEncryptionKey() ?? Buffer.from(loadOrCreateRuntimeSecrets().credKeyHex, 'hex');
}

export function hashPassword(password: string): string {
  if (password.length < 8) {
    throw new Error('A senha deve ter pelo menos 8 caracteres.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hexDigest] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexDigest, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashSessionToken(token: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(token).digest('hex');
}

export function encryptCredentials(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const key = getEncryptionKey();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptCredentials(ciphertext: string): string {
  const [ivB64, tagB64, dataB64] = ciphertext.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Formato de credencial criptografada inválido.');
  }
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

function isPrivateIpv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (normalized.startsWith('fe80:')) return true;
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.slice('::ffff:'.length);
    if (net.isIPv4(v4)) return isPrivateIpv4(v4);
  }
  return false;
}

export interface SsrfValidationResult {
  ok: boolean;
  reason?: string;
  parsedUrl?: URL;
}

export function validateExternalUrl(rawUrl: string): SsrfValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, reason: 'URL inválida.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `Protocolo não permitido (${parsed.protocol}). Utilize apenas HTTP ou HTTPS.` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'Credenciais embutidas na URL não são permitidas.' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'metadata.google.internal'
  ) {
    return { ok: false, reason: `Host interno bloqueado pela política anti-SSRF (${host}).` };
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4 && isPrivateIpv4(host)) {
    return { ok: false, reason: `IP privado/reservado bloqueado pela política anti-SSRF (${host}).` };
  }
  if (ipVersion === 6 && isPrivateIpv6(host)) {
    return { ok: false, reason: `IPv6 privado/link-local bloqueado pela política anti-SSRF (${host}).` };
  }

  return { ok: true, parsedUrl: parsed };
}

export class SlidingWindowRateLimiter {
  private hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  check(key: string): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((ts) => ts > cutoff);
    if (recent.length >= this.maxRequests) {
      this.hits.set(key, recent);
      return { allowed: false, remaining: 0 };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true, remaining: this.maxRequests - recent.length };
  }
}
