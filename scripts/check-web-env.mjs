import { checkSecrets, webSecretNames } from './local-env.mjs';

try {
  checkSecrets(process.env, webSecretNames);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
