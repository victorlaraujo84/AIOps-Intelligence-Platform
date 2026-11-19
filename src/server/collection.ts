import type Database from 'better-sqlite3';
import net from 'node:net';

export type CollectionProtocol = 'snmp_v3' | 'mqtt' | 'icmp' | 'otlp' | 'http_agent';

export interface ScopeRecord {
  id: string;
  tenant_id: string;
  protocol: CollectionProtocol;
  target_cidr_or_host: string;
  port: number | null;
  rate_limit_rpm: number;
  is_active: number;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const oct = Number(p);
    if (oct < 0 || oct > 255) return null;
    num = (num << 8) + oct;
  }
  return num >>> 0;
}

export function matchIpv4Cidr(ip: string, cidr: string): boolean {
  const [networkStr, prefixStr] = cidr.split('/');
  if (!networkStr || !prefixStr) return false;
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;

  const ipInt = ipv4ToInt(ip);
  const netInt = ipv4ToInt(networkStr);
  if (ipInt === null || netInt === null) return false;

  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

/**
 * Verifica se um alvo (IP ou hostname) corresponde a uma regra de escopo autorizado.
 * Nunca libera varreduras genéricas; exige correspondência exata ou CIDR IPv4 válido.
 */
export function matchTargetPattern(target: string, scopePattern: string): boolean {
  const cleanTarget = target.trim().toLowerCase();
  const cleanPattern = scopePattern.trim().toLowerCase();
  if (!cleanTarget || !cleanPattern) return false;

  if (cleanTarget === cleanPattern) return true;

  if (cleanPattern.includes('/') && net.isIPv4(cleanTarget)) {
    return matchIpv4Cidr(cleanTarget, cleanPattern);
  }

  // Suporte restrito a wildcard de subdomínio explícito (*.sub.empresa.internal)
  if (cleanPattern.startsWith('*.')) {
    const suffix = cleanPattern.slice(1); // .sub.empresa.internal
    return cleanTarget.endsWith(suffix) && cleanTarget.length > suffix.length;
  }

  return false;
}

export function isTargetAuthorizedInScope(
  db: Database.Database,
  tenantId: string,
  protocol: CollectionProtocol,
  target: string,
): { authorized: boolean; matchedScope: ScopeRecord | null } {
  const scopes = db
    .prepare(
      `SELECT id, tenant_id, protocol, target_cidr_or_host, port, rate_limit_rpm, is_active
       FROM authorized_collection_scopes
       WHERE tenant_id = ? AND protocol = ? AND is_active = 1`,
    )
    .all(tenantId, protocol) as ScopeRecord[];

  for (const scope of scopes) {
    if (matchTargetPattern(target, scope.target_cidr_or_host)) {
      return { authorized: true, matchedScope: scope };
    }
  }

  return { authorized: false, matchedScope: null };
}
