import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localSecretNames, readLocalEnv } from './local-env.mjs';

// Fixtures somente em projeto/volumes descartáveis; nunca usa o projeto de homologação.
const config = readLocalEnv();
const project = `aiops-smoke-${crypto.randomBytes(6).toString('hex')}`;
assert.match(project, /^aiops-smoke-[a-f0-9]{12}$/);
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return String(port);
}
const env = { ...config, COMPOSE_PROJECT_NAME: project, WEB_PORT: await freePort(), API_PORT: await freePort() };
for (const name of localSecretNames) env[name] = crypto.randomBytes(32).toString('hex');
env.POSTGRES_USER = 'aiops_fixture';
env.POSTGRES_DB = 'aiops_fixture';
assert.notEqual(env.WEB_PORT, env.API_PORT);
const composeArgs = ['compose', '--file', path.resolve('compose.yaml'), '--project-name', project, '--env-file', path.resolve('.env')];
const redact = (text) => localSecretNames.reduce((safe, name) => safe.replaceAll(config[name], '[REDACTED]').replaceAll(env[name], '[REDACTED]'), text);
function docker(args) {
  const result = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(redact(`Docker falhou: ${result.error?.message ?? result.stderr}`));
  return result.stdout.trim();
}
const compose = (...args) => docker([...composeArgs, ...args]);
const web = `http://127.0.0.1:${env.WEB_PORT}`;
const api = `http://127.0.0.1:${env.API_PORT}`;
async function health(url) {
  for (let i = 0; i < 60; i += 1) {
    try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) return; } catch {}
    await delay(500);
  }
  throw new Error(`Serviço local indisponível: ${new URL(url).pathname}`);
}
async function request(route, { method = 'GET', body, token, expected = 200 } = {}) {
  const response = await fetch(web + route, {
    method, signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(response.status, expected, `${method} ${route}: status inesperado`);
  return response.json();
}
const pgSql = (sql) => compose('exec', '-T', 'postgres', 'sh', '-ec',
  'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --host=127.0.0.1 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-psqlrc --tuples-only --no-align --set=ON_ERROR_STOP=1 --command="$1"', 'sh', sql);
const connectivityProbe = `import asyncio, os, asyncpg
from redis.asyncio import Redis
async def main():
    db = await asyncpg.connect(os.environ['DATABASE_URL'].replace('postgresql+asyncpg://', 'postgresql://', 1), timeout=5)
    assert await db.fetchval('SELECT 1') == 1
    await db.close()
    cache = Redis.from_url(os.environ['REDIS_URL'], socket_connect_timeout=5)
    assert await cache.ping()
    await cache.aclose()
asyncio.run(main())`;

let failure;
try {
  console.log(`Projeto de teste isolado: ${project}`);
  compose('config', '--quiet');
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180');
  await health(web + '/api/health');
  await health(api + '/health');
  const redirect = await fetch(api + '/docs/', { redirect: 'manual' });
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get('location'), api + '/docs');
  // Recria o upstream sem reiniciar o gateway; DNS deve voltar a resolver.
  compose('up', '-d', '--no-build', '--no-deps', '--force-recreate', '--wait', 'api');
  await health(api + '/health');
  for (const service of ['gateway', 'web', 'api', 'postgres', 'redis']) {
    const id = compose('ps', '-q', service);
    const [info] = JSON.parse(docker(['inspect', id]));
    const bindings = info.HostConfig.PortBindings ?? {};
    if (service === 'gateway') {
      assert.equal(Object.keys(bindings).length, 2);
      assert.ok(Object.values(bindings).flat().every((binding) => binding.HostIp === '127.0.0.1'));
    } else assert.equal(Object.keys(bindings).length, 0);
    if (['gateway', 'web', 'api'].includes(service)) {
      assert.ok(info.Config.User && !['0', 'root'].includes(info.Config.User));
      assert.equal(info.HostConfig.ReadonlyRootfs, true);
    }
    for (const network of Object.keys(info.NetworkSettings.Networks)) {
      const internal = JSON.parse(docker(['network', 'inspect', network]))[0].Internal;
      assert.equal(internal, network !== `${project}_edge`);
      if (network === `${project}_edge`) assert.equal(service, 'gateway');
    }
  }
  compose('exec', '-T', 'api', 'python', '-c', connectivityProbe);
  assert.ok(pgSql('SELECT PostGIS_Version()').startsWith('3.'));
  assert.match(compose('exec', '-T', 'redis', 'redis-cli', 'ping'), /NOAUTH/);
  console.log('Saúde, conexões autenticadas, PostGIS, portas locais e isolamento de redes verificados.');

  assert.equal((await request('/api/auth/status')).bootstrap_required, true);
  await request('/api/sites', { expected: 401 });
  const password = crypto.randomBytes(24).toString('hex');
  const bootstrap = await request('/api/auth/bootstrap', { method: 'POST', expected: 201, body: {
    email: 'docker-fixture@test.invalid', full_name: 'Fixture automatizada Docker', password,
    initial_tenant_name: 'Fixture exclusiva de teste Docker',
  } });
  const token = bootstrap.token;
  const login = await request('/api/auth/login', { method: 'POST', body: { email: 'docker-fixture@test.invalid', password } });
  assert.ok(login.token);
  const site = (await request('/api/sites', { method: 'POST', token, expected: 201,
    body: { code: 'DOCKER-FIXTURE', name: 'Fixture exclusiva do teste automatizado' } })).site;
  const asset = (await request('/api/assets', { method: 'POST', token, expected: 201,
    body: { name: 'Ativo fixture Docker', site_id: site.id, domain: 'ti' } })).asset;
  const connector = (await request('/api/integrations/connectors', { method: 'POST', token, expected: 201,
    body: { name: 'Receptor fixture local', connector_type: 'webhook_csv' } }));
  const timestamp = new Date().toISOString();
  const event = { idempotency_key: 'docker-smoke-fixture', site_id: site.id, asset_id: asset.id,
    event_time_utc: timestamp, observed_at_utc: timestamp, source: 'automated_docker_fixture', event_type: 'test_heartbeat', status: 'UP' };
  const ingestPath = `/api/integrations/connectors/${connector.id}/ingest`;
  assert.equal((await request(ingestPath, { method: 'POST', token, body: { events: [event] }, expected: 201 })).ingested, 1);
  assert.equal((await request(ingestPath, { method: 'POST', token, body: { events: [event] }, expected: 201 })).deduplicated, 1);
  await request('/api/users', { method: 'POST', token, expected: 201, body: {
    email: 'viewer-fixture@test.invalid', full_name: 'Viewer fixture', password, role: 'tenant_viewer',
  } });
  const viewer = await request('/api/auth/login', { method: 'POST', body: { email: 'viewer-fixture@test.invalid', password } });
  await request('/api/sites', { method: 'POST', token: viewer.token, body: { code: 'DENIED', name: 'Fixture bloqueada' }, expected: 403 });
  assert.equal((await request('/api/ml/status', { token })).model_status, 'MODEL_NOT_VALIDATED');
  compose('restart', 'web');
  await health(web + '/api/health');
  await request('/api/auth/me', { token });
  assert.ok((await request('/api/sites', { token })).sites.some((item) => item.id === site.id));
  console.log('Login, RBAC, inventário, deduplicação e sessão após restart verificados com fixtures isoladas.');

  compose('exec', '-T', 'web', 'node', '--input-type=module', '-e',
    "import fs from 'node:fs'; import Database from 'better-sqlite3'; fs.mkdirSync('/app/data/backups',{recursive:true}); const db=new Database('/app/data/aiops.db'); await db.backup('/app/data/backups/docker-smoke.db'); db.close();");
  await request(`/api/sites/${site.id}`, { method: 'DELETE', token });
  assert.ok(!(await request('/api/sites', { token })).sites.some((item) => item.id === site.id));
  compose('stop', 'web');
  // Apenas volume descartável deste projeto aleatório, com o escritor parado.
  compose('run', '--rm', '--no-deps', '--entrypoint', 'node', 'web', '-e',
    "const fs=require('node:fs'); for(const suffix of ['-wal','-shm']) fs.rmSync('/app/data/aiops.db'+suffix,{force:true}); fs.copyFileSync('/app/data/backups/docker-smoke.db','/app/data/aiops.db');");
  compose('up', '-d', '--no-build', '--no-deps', '--wait', '--wait-timeout', '60', 'web');
  assert.ok((await request('/api/sites', { token })).sites.some((item) => item.id === site.id));
  pgSql("CREATE TABLE docker_smoke_probe (marker TEXT NOT NULL); INSERT INTO docker_smoke_probe VALUES ('fixture');");
  compose('exec', '-T', 'redis', 'sh', '-ec', 'export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli SET aiops:smoke persisted');
  compose('restart', 'postgres', 'redis');
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120');
  compose('exec', '-T', 'api', 'python', '-c', connectivityProbe);
  assert.equal(pgSql('SELECT count(*) FROM docker_smoke_probe'), '1');
  assert.equal(compose('exec', '-T', 'redis', 'sh', '-ec', 'export REDISCLI_AUTH="$REDIS_PASSWORD"; exec redis-cli GET aiops:smoke'), 'persisted');
  compose('exec', '-T', 'postgres', 'sh', '-ec',
    'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc -f /tmp/aiops-smoke.dump; createdb -U "$POSTGRES_USER" aiops_smoke_restore; pg_restore -U "$POSTGRES_USER" -d aiops_smoke_restore --exit-on-error /tmp/aiops-smoke.dump');
  assert.equal(compose('exec', '-T', 'postgres', 'sh', '-ec',
    'psql -U "$POSTGRES_USER" -d aiops_smoke_restore -tA -c "SELECT count(*) FROM docker_smoke_probe"').trim(), '1');
  console.log('Persistência PostgreSQL/Redis, backup/restore SQLite e PostgreSQL verificados. RLS efetiva permanece pendente.');
} catch (error) {
  failure = error;
} finally {
  try { compose('down', '--volumes', '--remove-orphans'); }
  catch (error) { failure ??= error; }
}
if (failure) {
  console.error(redact(failure.message));
  process.exitCode = 1;
} else console.log('Teste Docker concluído; projeto e volumes de fixtures removidos.');
