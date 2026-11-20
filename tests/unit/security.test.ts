import crypto from 'node:crypto';
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

test('chave AES explícita preserva credenciais cifradas pelo runtime legado', (t) => {
  const previousKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    else process.env.CREDENTIAL_ENCRYPTION_KEY = previousKey;
  });

  const legacyKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', legacyKey, iv);
  const expected = 'credencial de fixture';
  const encrypted = Buffer.concat([cipher.update(expected, 'utf8'), cipher.final()]);
  const stored = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');

  process.env.CREDENTIAL_ENCRYPTION_KEY = `hex:${legacyKey.toString('hex')}`;
  assert.equal(decryptCredentials(stored), expected);
});
