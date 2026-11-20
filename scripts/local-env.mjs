import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

export const webSecretNames = ['AUTH_SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY'];
export const localSecretNames = [...webSecretNames, 'POSTGRES_PASSWORD', 'REDIS_PASSWORD'];

export function checkSecrets(env, names) {
  for (const name of names) {
    if (!/^[a-f0-9]{64}$/i.test(env[name] ?? '')) {
      throw new Error(`${name}: configure 32 bytes aleatórios em hexadecimal (64 caracteres).`);
    }
  }
  if (new Set(names.map((name) => env[name])).size !== names.length) {
    throw new Error('Use segredos distintos para cada finalidade.');
  }
}

export function readLocalEnv(directory = process.cwd()) {
  const filename = path.join(directory, '.env');
  if (!fs.existsSync(filename)) throw new Error('.env ausente. Execute npm run docker:init.');
  // Compose dá precedência às variáveis exportadas no shell.
  const env = { ...parse(fs.readFileSync(filename)), ...process.env };
  checkSecrets(env, localSecretNames);
  for (const name of ['POSTGRES_USER', 'POSTGRES_DB']) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(env[name] ?? '')) throw new Error(`${name}: identificador local inválido.`);
  }
  for (const name of ['WEB_PORT', 'API_PORT']) {
    const value = Number(env[name]);
    if (!/^[0-9]+$/.test(env[name] ?? '') || !Number.isInteger(value) || value < 1024 || value > 65535) throw new Error(`${name}: use porta decimal entre 1024 e 65535.`);
  }
  if (Number(env.WEB_PORT) === Number(env.API_PORT)) throw new Error('WEB_PORT e API_PORT precisam ser diferentes.');
  if (!/^[a-z0-9][a-z0-9_-]{0,48}$/.test(env.COMPOSE_PROJECT_NAME ?? '')) throw new Error('COMPOSE_PROJECT_NAME inválido.');
  return env;
}
