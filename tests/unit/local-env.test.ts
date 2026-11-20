import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const root = fileURLToPath(new URL('../../', import.meta.url));
const secretNames = ['AUTH_SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD'];

function temporaryEnv(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiops-env-test-'));
  fs.copyFileSync(path.join(root, '.env.example'), path.join(dir, '.env.example'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('aiops-env-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function run(script: string, cwd: string, overrides: Record<string, string> = {}) {
  const env = { ...process.env };
  for (const name of [...secretNames, 'COMPOSE_PROJECT_NAME', 'POSTGRES_USER', 'POSTGRES_DB', 'WEB_PORT', 'API_PORT']) delete env[name];
  return spawnSync(process.execPath, [path.join(root, 'scripts', script)], {
    cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15000,
  });
}

test('gera configuração local com segredos distintos e não os imprime', (t) => {
  const dir = temporaryEnv(t);
  const result = run('init-local-env.mjs', dir);
  assert.equal(result.status, 0, result.stderr);
  const values = parse(fs.readFileSync(path.join(dir, '.env')));
  assert.equal(new Set(secretNames.map((name) => values[name])).size, 4);
  for (const name of secretNames) {
    assert.match(values[name], /^[a-f0-9]{64}$/);
    assert.ok(!(result.stdout + result.stderr).includes(values[name]));
  }
  assert.equal(values.AI_AGENT_MODE, 'offline');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
});

test('inicialização recusa sobrescrever configuração existente', (t) => {
  const dir = temporaryEnv(t);
  const original = '# fixture isolada que deve ser preservada\n';
  fs.writeFileSync(path.join(dir, '.env'), original);
  const result = run('init-local-env.mjs', dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /já existe/);
  assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), original);
});

test('validação local bloqueia ausência e placeholders sem divulgar o valor', (t) => {
  const dir = temporaryEnv(t);
  assert.notEqual(run('check-local-env.mjs', dir).status, 0);
  assert.equal(run('init-local-env.mjs', dir).status, 0);
  const good = run('check-local-env.mjs', dir);
  assert.equal(good.status, 0, good.stderr);
  const invalid = run('check-local-env.mjs', dir, { POSTGRES_PASSWORD: 'CHANGE_ME_FIXTURE' });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /POSTGRES_PASSWORD/);
  assert.ok(!invalid.stderr.includes('CHANGE_ME_FIXTURE'));
});

test('entrada Docker web exige ambas as chaves antes de iniciar a aplicação', (t) => {
  const dir = temporaryEnv(t);
  const missing = run('check-web-env.mjs', dir);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /AUTH_SESSION_SECRET/);
  const valid = run('check-web-env.mjs', dir, {
    AUTH_SESSION_SECRET: 'a'.repeat(64), CREDENTIAL_ENCRYPTION_KEY: 'b'.repeat(64),
  });
  assert.equal(valid.status, 0, valid.stderr);
});

test('validação recusa portas numericamente iguais mesmo com zeros à esquerda', (t) => {
  const dir = temporaryEnv(t);
  assert.equal(run('init-local-env.mjs', dir).status, 0);
  const result = run('check-local-env.mjs', dir, { WEB_PORT: '03000', API_PORT: '3000' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /precisam ser diferentes/);
});

test('validação aceita somente representação decimal de portas', (t) => {
  const dir = temporaryEnv(t);
  assert.equal(run('init-local-env.mjs', dir).status, 0);
  for (const value of ['3e3', '0xBB8', '3000.0']) {
    const result = run('check-local-env.mjs', dir, { WEB_PORT: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /porta decimal/);
  }
});
