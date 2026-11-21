import { getOutboundHttps, postOutboundHttpsJson, validateOutboundHttpsUrl } from './outbound-http.ts';

type Basic = { method: 'basic'; username: string; apiPassword: string };
type Bearer = { method: 'bearer'; accessToken: string };
type Glpi = { method: 'glpi_session'; userToken: string; appToken?: string };
type JsonScalar = string | number | boolean | null;

export type ItsmDestination = {
  baseUrl: string;
  allowedOrigin: string;
  capabilities: { create_ticket: boolean; get_ticket: boolean };
} & (
  | { provider: 'glpi'; auth: Glpi }
  | { provider: 'servicenow'; auth: Basic | Bearer }
  | { provider: 'jira-service-management'; auth: Basic | Bearer; serviceDeskId: string; requestTypeId: string;
      requiredFields?: Readonly<Record<string, JsonScalar>> }
  | { provider: 'topdesk'; auth: Basic; callerId: string }
);

type TicketInput = { summary: string; description: string };
type RemoteTicket = { externalId: string; reference: string | null };
type FailureCode = 'NOT_SUPPORTED' | 'VALIDATION' | 'AUTH' | 'PERMISSION' | 'NOT_FOUND' | 'RATE_LIMIT'
  | 'REMOTE_ERROR' | 'NETWORK' | 'NEEDS_RECONCILIATION';
type Result<T> = { ok: true; value: T } | { ok: false; code: FailureCode; retryable: boolean };

type Transport = { get: typeof getOutboundHttps; post: typeof postOutboundHttpsJson };
const defaultTransport: Transport = { get: getOutboundHttps, post: postOutboundHttpsJson };
const resourcePaths = {
  glpi: '/apirest.php/Ticket',
  servicenow: '/api/now/v1/table/incident',
  'jira-service-management': '/rest/servicedeskapi/request',
  topdesk: '/tas/api/incidents',
};
const ticketIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const uuidPattern = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;

function failure(code: FailureCode, retryable = false): Result<never> {
  return { ok: false, code, retryable };
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

function strId(value: unknown): string | undefined {
  if (typeof value === 'string' && ticketIdPattern.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
}

function remoteTicket(provider: ItsmDestination['provider'], body: unknown): RemoteTicket | undefined {
  const outer = record(body);
  const item = provider === 'servicenow' ? record(outer?.result) : outer;
  if (!item) return;
  const id = provider === 'servicenow' ? item.sys_id : provider === 'jira-service-management' ? item.issueKey : item.id;
  const externalId = strId(id);
  if (!externalId) return;
  const reference = typeof item.number === 'string' && item.number.length <= 128 ? item.number : null;
  return { externalId, reference };
}

function ticketPayload(destination: ItsmDestination, { summary, description }: TicketInput): object | undefined {
  if (!summary.trim() || summary.length > 255 || description.length > 4000) return;
  switch (destination.provider) {
    case 'glpi':
      return { input: { name: summary, content: description } };
    case 'servicenow':
      return { short_description: summary, description };
    case 'jira-service-management': {
      const { serviceDeskId, requestTypeId, requiredFields } = destination;
      if (!/^\d+$/.test(serviceDeskId) || !/^\d+$/.test(requestTypeId)) return;
      const fields = Object.entries(requiredFields ?? {});
      if (fields.some(([key, value]) => !/^customfield_\d+$/.test(key)
        || (value !== null && !['boolean', 'number', 'string'].includes(typeof value)))) return;
      return { serviceDeskId, requestTypeId, requestFieldValues: { ...requiredFields, summary, description } };
    }
    case 'topdesk':
      if (!uuidPattern.test(destination.callerId) || summary.length > 80) return;
      return { briefDescription: summary, request: description, caller: { id: destination.callerId } };
  }
}

function headerToken(value: string): boolean {
  return value.length <= 4096 && /^[\x21-\x7E]+$/.test(value);
}

function providerHeaders(auth: Basic | Bearer): Record<string, string> | undefined {
  if (auth.method === 'bearer') {
    if (!headerToken(auth.accessToken)) return;
    return { Authorization: 'Bearer ' + auth.accessToken };
  }
  if (!auth.username || auth.username.includes(':') || !auth.apiPassword
    || /[\x00-\x1f\x7f]/.test(auth.username + auth.apiPassword)
    || auth.username.length > 254 || auth.apiPassword.length > 4096) return;
  return { Authorization: 'Basic ' + Buffer.from(auth.username + ':' + auth.apiPassword).toString('base64') };
}

function httpFailure(status: number, creating: boolean): Result<never> {
  if (status === 401) return failure('AUTH');
  if (status === 403) return failure('PERMISSION');
  if (status === 404) return failure('NOT_FOUND');
  if (status === 429) return failure('RATE_LIMIT', true);
  if (status >= 500 || status === 408) {
    return creating ? failure('NEEDS_RECONCILIATION') : failure('REMOTE_ERROR', true);
  }
  return failure('VALIDATION');
}

export function createItsmAdapter(destination: ItsmDestination, transport: Transport = defaultTransport) {
  const validated = validateOutboundHttpsUrl(destination.baseUrl);
  const base = validated.parsedUrl;
  if (!validated.ok || !base || base.origin !== destination.allowedOrigin || base.search || base.hash) {
    throw new Error('Origem HTTPS do ITSM fora da configuração autorizada.');
  }

  const baseUrl = base.href;
  function endpoint(path: string) {
    const url = new URL(baseUrl);
    url.pathname = url.pathname.replace(/\/+$/, '') + path;
    return url.href;
  }

  async function execute(operation: (headers: Record<string, string>) => Promise<Result<RemoteTicket>>): Promise<Result<RemoteTicket>> {
    const auth = destination.auth;
    const headers = { Accept: 'application/json' };
    if (auth.method !== 'glpi_session') {
      const authorization = providerHeaders(auth);
      return authorization ? operation({ ...headers, ...authorization }) : failure('AUTH');
    }
    if (!headerToken(auth.userToken) || (auth.appToken !== undefined && !headerToken(auth.appToken))) return failure('AUTH');
    const app: Record<string, string> = auth.appToken ? { 'App-Token': auth.appToken } : {};
    let token: string;
    try {
      const session = await transport.get(endpoint('/apirest.php/initSession'), {
        headers: { ...headers, ...app, Authorization: 'user_token ' + auth.userToken },
      });
      if (!session.ok) return httpFailure(session.status, false);
      const sessionToken = record(session.json())?.session_token;
      if (typeof sessionToken !== 'string' || !headerToken(sessionToken)) return failure('AUTH');
      token = sessionToken;
    } catch {
      return failure('NETWORK', true);
    }
    const sessionHeaders = { ...headers, ...app, 'Session-Token': token };
    try {
      return await operation(sessionHeaders);
    } finally {
      // A falha de encerramento da sessão não deve repetir uma criação já confirmada.
      await transport.get(endpoint('/apirest.php/killSession'), { headers: sessionHeaders, statusOnly: true }).catch(() => {});
    }
  }

  async function getTicket(externalId: string): Promise<Result<RemoteTicket>> {
    if (!destination.capabilities.get_ticket) return failure('NOT_SUPPORTED');
    if (!ticketIdPattern.test(externalId)) return failure('VALIDATION');
    const path = resourcePaths[destination.provider] + (destination.provider === 'topdesk' ? '/id/' : '/') + externalId;
    return execute(async headers => {
      try {
        const response = await transport.get(endpoint(path), { headers });
        if (!response.ok) return httpFailure(response.status, false);
        const ticket = remoteTicket(destination.provider, response.json());
        return ticket?.externalId === externalId ? { ok: true, value: ticket } : failure('VALIDATION');
      } catch {
        return failure('NETWORK', true);
      }
    });
  }

  async function createTicket(input: TicketInput): Promise<Result<RemoteTicket>> {
    if (!destination.capabilities.create_ticket) return failure('NOT_SUPPORTED');
    const payload = ticketPayload(destination, input);
    if (!payload) return failure('VALIDATION');
    return execute(async headers => {
      try {
        const response = await transport.post(endpoint(resourcePaths[destination.provider]), payload, { headers });
        if (!response.ok) return httpFailure(response.status, true);
        if (response.status !== 201) return failure('NEEDS_RECONCILIATION');
        const ticket = remoteTicket(destination.provider, response.json());
        return ticket ? { ok: true, value: ticket } : failure('NEEDS_RECONCILIATION');
      } catch {
        return failure('NEEDS_RECONCILIATION');
      }
    });
  }

  return { createTicket, getTicket };
}
