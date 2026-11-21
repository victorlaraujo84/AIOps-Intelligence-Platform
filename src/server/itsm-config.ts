import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { type ItsmDestination } from './itsm-http.ts';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuração inválida.');
  return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item.trim()) throw new Error('Campo de configuração obrigatório.');
  return item;
}

export function parseItsmDestination(value: unknown, create: boolean): ItsmDestination {
  const config = record(value);
  const common = {
    baseUrl: field(config, 'baseUrl'),
    allowedOrigin: field(config, 'allowedOrigin'),
    capabilities: { create_ticket: create, get_ticket: !create },
  };
  const auth = record(config.auth);
  if (config.provider === 'glpi' && auth.method === 'glpi_session') {
    return {
      ...common, provider: 'glpi',
      auth: {
        method: 'glpi_session', userToken: field(auth, 'userToken'),
        appToken: auth.appToken === undefined ? undefined : field(auth, 'appToken'),
      },
    };
  }
  if (config.provider !== 'servicenow' && config.provider !== 'jira-service-management' && config.provider !== 'topdesk') {
    throw new Error('Destino ITSM ou autenticação inválida.');
  }
  if (config.provider === 'topdesk') {
    if (auth.method !== 'basic') throw new Error('Autenticação TOPdesk inválida.');
    return {
      ...common, provider: 'topdesk', callerId: field(config, 'callerId'),
      auth: { method: 'basic', username: field(auth, 'username'), apiPassword: field(auth, 'apiPassword') },
    };
  }
  if (auth.method !== 'basic' && auth.method !== 'bearer') throw new Error('Autenticação ITSM inválida.');
  const credential = auth.method === 'basic'
    ? { method: 'basic' as const, username: field(auth, 'username'), apiPassword: field(auth, 'apiPassword') }
    : { method: 'bearer' as const, accessToken: field(auth, 'accessToken') };
  if (config.provider === 'servicenow') return { ...common, provider: 'servicenow', auth: credential };
  const requiredFields = config.requiredFields === undefined ? {} : record(config.requiredFields);
  const fields: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(requiredFields)) {
    if (!/^customfield_\d+$/.test(key)) throw new Error('Mapeamento de campo Jira inválido.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean'
        || (typeof value === 'number' && Number.isFinite(value))) {
      fields[key] = value;
    } else {
      throw new Error('O mapeamento Jira aceita valores escalares.');
    }
  }
  return {
    ...common, provider: 'jira-service-management', auth: credential,
    serviceDeskId: field(config, 'serviceDeskId'), requestTypeId: field(config, 'requestTypeId'), requiredFields: fields,
  };
}

export async function readPrivateItsmFile(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 || (stat.mode & 0o077) !== 0) {
      throw new Error('Use um arquivo de configuração privado.');
    }
    return JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
}
