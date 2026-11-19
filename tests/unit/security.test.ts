import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decryptCredentials,
  encryptCredentials,
  hashPassword,
  validateExternalUrl,
  verifyPassword,
} from '../../src/server/security.ts';

test('hash e verificação de senha com scrypt e timingSafeEqual', () => {
  const hash = hashPassword('SenhaForte#2026');
  assert.equal(verifyPassword('SenhaForte#2026', hash), true);
  assert.equal(verifyPassword('SenhaErrada#2026', hash), false);
});

test('criptografia AES-256-GCM de credenciais em repouso', () => {
  const secret = 'zabbix_api_token_fixture_only';
  const encrypted = encryptCredentials(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(decryptCredentials(encrypted), secret);
});

test('proteção anti-SSRF bloqueia endereços internos, metadata e esquemas inseguros', () => {
  assert.equal(validateExternalUrl('http://127.0.0.1:8080/api').ok, false);
  assert.equal(validateExternalUrl('http://localhost:3000/api').ok, false);
  assert.equal(validateExternalUrl('http://169.254.169.254/latest/meta-data/').ok, false);
  assert.equal(validateExternalUrl('http://10.0.0.12/zabbix').ok, false);
  assert.equal(validateExternalUrl('http://192.168.1.1/status').ok, false);
  assert.equal(validateExternalUrl('file:///etc/passwd').ok, false);
  assert.equal(validateExternalUrl('https://api.open-meteo.com/v1/forecast').ok, true);
});
