import dns from 'node:dns/promises';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { isPublicIpAddress, validateExternalUrl, type SsrfValidationResult } from './security.ts';

const MAX_RESPONSE_BYTES = 1024 * 1024;

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
  json(): unknown;
}

export async function getOutboundHttps(rawUrl: string, options: OutboundOptions = {}): Promise<OutboundResponse> {
  const { parsedUrl, reason } = validateOutboundHttpsUrl(rawUrl);
  if (!parsedUrl) throw new Error(reason ?? 'Destino HTTPS inválido.');

  return new Promise((resolve, reject) => {
    const request = https.get(parsedUrl, {
      agent: false,
      headers: options.headers,
      lookup: lookupPublic,
      signal: AbortSignal.timeout(options.timeoutMs ?? 6000),
    }, (response) => {
      const status = response.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        response.destroy();
        reject(new Error('Redirecionamento bloqueado. Configure o endpoint HTTPS final.'));
        return;
      }

      const ok = status >= 200 && status < 300;
      if (options.statusOnly || !ok) {
        resolve({ status, ok, json: () => { throw new Error('Resposta sem corpo disponível.'); } });
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
    });
    request.on('error', reject);
  });
}
