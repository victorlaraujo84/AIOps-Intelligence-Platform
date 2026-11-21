import dns from 'node:dns/promises';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPublicIpAddress, validateExternalUrl, type SsrfValidationResult } from './security.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 64 * 1024;

export function validateOutboundHttpsUrl(rawUrl: string): SsrfValidationResult {
  const result = validateExternalUrl(rawUrl);
  if (result.ok && result.parsedUrl?.protocol !== 'https:') {
    return { ok: false, reason: 'O endpoint do conector deve usar HTTPS.' };
  }
  return result;
}

const lookupPublic: LookupFunction = (hostname, options, callback) => {
  // O socket usa as próprias respostas verificadas, sem uma segunda resolução.
  void dns.lookup(hostname, { all: true }).then(
    (addresses) => {
      if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
        callback(new Error('O DNS retornou um endereço fora da política de saída.'), '');
        return;
      }
      if (options.all) {
        callback(null, addresses);
      } else {
        const selected = addresses[0];
        callback(null, selected.address, selected.family);
      }
    },
    () => callback(new Error('Falha ao resolver o destino HTTPS.'), ''),
  );
};

interface OutboundOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  statusOnly?: boolean;
}

interface OutboundResponse {
  ok: boolean;
  status: number;
  retryAfterSeconds?: number;
  json(): unknown;
}

export function getOutboundHttps(rawUrl: string, options: OutboundOptions = {}): Promise<OutboundResponse> {
  return outboundHttps(rawUrl, 'GET', options);
}

export function postOutboundHttpsJson(rawUrl: string, body: object, options: OutboundOptions = {}): Promise<OutboundResponse> {
  return outboundHttps(rawUrl, 'POST', options, JSON.stringify(body));
}

function retryAfter(value: string | undefined): number | undefined {
  if (!value) return;
  const seconds = /^\d+$/.test(value) ? Number(value) : Math.ceil((Date.parse(value) - Date.now()) / 1000);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, 86_400);
}

async function outboundHttps(
  rawUrl: string, method: 'GET' | 'POST', options: OutboundOptions, body?: string,
): Promise<OutboundResponse> {
  const { parsedUrl, reason } = validateOutboundHttpsUrl(rawUrl);
  if (!parsedUrl) throw new Error(reason ?? 'Destino HTTPS inválido.');

  const length = body === undefined ? 0 : Buffer.byteLength(body);
  if (length > MAX_REQUEST_BYTES) throw new Error('A solicitação HTTPS excede o limite de 64 KiB.');
  const headers = body === undefined ? options.headers : {
    ...options.headers, 'Content-Type': 'application/json', 'Content-Length': length.toString(),
  };
  return new Promise((resolve, reject) => {
    const settings: https.RequestOptions = {
      method,
      agent: false,
      headers,
      lookup: lookupPublic,
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    };
    function onResponse(response: IncomingMessage) {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new Error('Redirecionamento bloqueado. Configure o endpoint HTTPS final.'));
        return;
      }

      const ok = status >= 200 && status < 300;
      if (options.statusOnly || !ok) {
        resolve({
          status, ok, retryAfterSeconds: retryAfter(response.headers?.['retry-after']),
          json: () => { throw new Error('Resposta sem corpo disponível.'); },
        });
        response.destroy();
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > MAX_RESPONSE_BYTES) {
          response.destroy(new Error('A resposta HTTPS excede o limite de 1 MiB.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({ status, ok, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      });
    }
    const request = method === 'GET'
      ? https.get(parsedUrl, settings, onResponse)
      : https.request(parsedUrl, settings, onResponse);
    request.on('error', reject);
    if (method === 'POST') request.end(body);
  });
}
