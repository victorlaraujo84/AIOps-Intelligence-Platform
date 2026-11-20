import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { localSecretNames } from './local-env.mjs';

try {
  let template = fs.readFileSync(path.resolve('.env.example'), 'utf8');
  for (const name of localSecretNames) {
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    if (!pattern.test(template)) throw new Error(`.env.example não contém ${name}.`);
    template = template.replace(pattern, `${name}=${crypto.randomBytes(32).toString('hex')}`);
  }
  fs.writeFileSync(path.resolve('.env'), template, { flag: 'wx', mode: 0o600 });
  console.log('.env local criado com segredos aleatórios; valores não exibidos.');
} catch (error) {
  console.error(error?.code === 'EEXIST' ? '.env já existe; arquivo preservado.' : error.message);
  process.exitCode = 1;
}
