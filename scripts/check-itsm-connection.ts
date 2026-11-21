import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createItsmAdapter, type ItsmDestination } from '../src/server/itsm-http.ts';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuração inválida.');
  return value as Record<string, unknown>;
}

function field(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== 'string' || !item.trim()) throw new Error('Campo de configuração obrigatório.');
  return item;
}

function checkDestination(value: unknown): ItsmDestination {
  const config = record(value);
  const common = {
    baseUrl: field(config, 'baseUrl'),
    allowedOrigin: field(config, 'allowedOrigin'),
    capabilities: { create_ticket: false, get_ticket: true },
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
  return {
    ...common, provider: 'jira-service-management', auth: credential,
    serviceDeskId: field(config, 'serviceDeskId'), requestTypeId: field(config, 'requestTypeId'),
  };
}

async function main(file: string | undefined, externalId: string | undefined) {
  if (!file || !externalId || process.argv.length !== 4) {
    throw new Error('Uso: node --import tsx scripts/check-itsm-connection.ts ARQUIVO_PRIVADO ID_DE_TESTE');
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let config: unknown;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 16 * 1024 || (stat.mode & 0o077) !== 0) {
      throw new Error('Use um arquivo de configuração privado.');
    }
    config = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }

  const destination = checkDestination(config);
  const result = await createItsmAdapter(destination).getTicket(externalId);
  if (result.ok) {
    console.log(`${destination.provider} get_ticket verificado com um registro existente.`);
  } else {
    console.error(`Consulta ITSM falhou (${result.code}).`);
    process.exitCode = 1;
  }
}

main(process.argv[2], process.argv[3]).catch(() => {
  console.error('Confira os argumentos, as permissões do arquivo e a configuração do destino ITSM.');
  process.exitCode = 1;
});
