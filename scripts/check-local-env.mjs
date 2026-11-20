import { readLocalEnv } from './local-env.mjs';

try {
  readLocalEnv();
  console.log('Configuração local válida; segredos não exibidos.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
