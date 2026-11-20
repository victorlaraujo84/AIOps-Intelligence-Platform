import assert from 'node:assert/strict';
import test from 'node:test';
import { validateExternalUrl } from '../../src/server/security.ts';

test('SSRF rejeita IPv4 interno representado como IPv6, inclusive normalização WHATWG', () => {
  for (const host of [
    '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:a00:1',
    '::ffff:192.168.1.1', '::ffff:a9fe:a9fe', '::127.0.0.1',
    '64:ff9b::a9fe:a9fe', '64:ff9b:1::a00:1', '2002:7f00:1::',
  ]) assert.equal(validateExternalUrl(`http://[${host}]/probe`).ok, false, host);
});

test('SSRF rejeita faixas especiais IPv4 e IPv6 fora da política pública', () => {
  for (const host of [
    '192.0.0.8', '192.0.2.1', '192.88.99.1', '198.18.0.1', '198.19.255.254',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '[fe90::1]', '[febf::1]', '[fec0::1]', '[ff02::1]', '[100::1]',
    '[2001:2::1]', '[2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff]', '[2001:db8::1]', '[3fff::1]',
    '[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]',
  ]) assert.equal(validateExternalUrl(`https://${host}/probe`).ok, false, host);
});

test('SSRF aplica política conservadora às alocações especiais AS112 e AMT', () => {
  for (const host of ['192.31.196.0', '192.31.196.255', '192.52.193.0', '192.52.193.255', '192.175.48.0', '192.175.48.255']) {
    assert.equal(validateExternalUrl(`https://${host}/probe`).ok, false, host);
  }
  for (const host of ['192.31.195.255', '192.31.197.0', '192.52.192.255', '192.52.194.0', '192.175.47.255', '192.175.49.0', '[2001:200::1]', '[3fff:1000::1]']) {
    assert.equal(validateExternalUrl(`https://${host}/probe`).ok, true, host);
  }
});

test('SSRF rejeita hostname interno com ponto DNS final e IPv4 alternativo', () => {
  for (const host of ['localhost.', 'service.local.', 'service.internal.', 'sub.localhost.', '2130706433', '0x7f000001', '0177.0.0.1']) {
    assert.equal(validateExternalUrl(`http://${host}/probe`).ok, false, host);
  }
});

test('SSRF preserva endereços públicos e limites externos de faixas privadas', () => {
  for (const host of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '[2606:4700:4700::1111]', '[2001:4860:4860::8888]', 'api.open-meteo.com']) {
    assert.equal(validateExternalUrl(`https://${host}/probe`).ok, true, host);
  }
});
