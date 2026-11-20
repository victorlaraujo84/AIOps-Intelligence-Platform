import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import test from 'node:test';
import { getOutboundHttps, validateOutboundHttpsUrl } from '../../src/server/outbound-http.ts';

test('exige HTTPS no cadastro do destino de saída', () => {
  assert.equal(validateOutboundHttpsUrl('http://connector.example.com/status').ok, false);
  assert.equal(validateOutboundHttpsUrl('https://connector.example.com/status').ok, true);
});

const publicAnswers = [{ address: '8.8.8.8', family: 4 }];
const reservedAnswers = [...publicAnswers, { address: '192.0.2.1', family: 4 }];

test('entrega ao socket somente a resolução DNS aprovada', async (t) => {
  const resolver = t.mock.method(dns, 'lookup', async () => publicAnswers);
  const get = t.mock.method(https, 'get', (
    _url: URL, options: https.RequestOptions, onResponse: (response: IncomingMessage) => void,
  ) => {
    queueMicrotask(() => {
      options.lookup?.('connector.example.com', { all: true }, (err, addresses) => {
        assert.ifError(err);
        assert.deepEqual(addresses, publicAnswers);
        const body = Readable.from([Buffer.from('{"ready":true}')]);
        onResponse(Object.assign(body, { statusCode: 200 }) as unknown as IncomingMessage);
      });
    });
    return new EventEmitter();
  });

  const result = await getOutboundHttps('https://connector.example.com/status');
  assert.equal(result.status, 200);
  assert.deepEqual(result.json(), { ready: true });
  assert.equal(resolver.mock.callCount(), 1);
  assert.equal(get.mock.callCount(), 1);
});

test('rejeita DNS misto sem entregar endereços ao socket', async (t) => {
  t.mock.method(dns, 'lookup', async () => reservedAnswers);
  t.mock.method(https, 'get', (_url: URL, options: https.RequestOptions) => {
    const request = new EventEmitter();
    queueMicrotask(() => {
      options.lookup?.('connector.example.com', { all: true }, (err, addresses) => {
        assert.ok(err);
        assert.equal(addresses, '');
        request.emit('error', err);
      });
    });
    return request;
  });

  await assert.rejects(getOutboundHttps('https://connector.example.com/status'), /política de saída/);
});

test('encerra a resposta de redirecionamento sem outra requisição', async (t) => {
  const get = t.mock.method(https, 'get', (
    _url: URL, _options: https.RequestOptions, onResponse: (response: IncomingMessage) => void,
  ) => {
    const body = Readable.from([]);
    queueMicrotask(() => onResponse(Object.assign(body, { statusCode: 302 }) as unknown as IncomingMessage));
    return new EventEmitter();
  });

  await assert.rejects(getOutboundHttps('https://connector.example.com/status', { statusOnly: true }), /Redirecionamento bloqueado/);
  assert.equal(get.mock.callCount(), 1);
});

test('interrompe respostas JSON acima do limite', async (t) => {
  t.mock.method(https, 'get', (
    _url: URL, _options: https.RequestOptions, onResponse: (response: IncomingMessage) => void,
  ) => {
    const body = Readable.from([Buffer.alloc(1024 * 1024 + 1)]);
    queueMicrotask(() => onResponse(Object.assign(body, { statusCode: 200 }) as unknown as IncomingMessage));
    return new EventEmitter();
  });

  await assert.rejects(getOutboundHttps('https://connector.example.com/status'), /limite de 1 MiB/);
});
