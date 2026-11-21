// Somente dados descartáveis de autenticação usados no smoke do Docker.
import { scryptSync } from 'node:crypto';

const salt = '0123456789abcdef0123456789abcdef';
const hash = (password) => `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
const active = '00000000-0000-4000-b000-000000000001';
const suspended = '00000000-0000-4000-b000-000000000002';

console.log(`
BEGIN;
CREATE ROLE aiops_auth_ci LOGIN PASSWORD 'auth-ci-fixture-only';
GRANT aiops_authenticator TO aiops_auth_ci;
INSERT INTO tenants (id, name, slug, status) VALUES
  ('${active}', 'Auth CI', 'auth-ci', 'active'),
  ('${suspended}', 'Auth CI suspenso', 'auth-ci-suspended', 'suspended');
INSERT INTO users (tenant_id, email, full_name, role, password_hash, is_active) VALUES
  ('${active}', 'operator-auth@example.invalid', 'Operador CI', 'tenant_operator', '${hash('operator-ci-fixture-only')}', true),
  ('${active}', 'disabled-auth@example.invalid', 'Desativado CI', 'tenant_viewer', '${hash('operator-ci-fixture-only')}', false),
  ('${suspended}', 'suspended-auth@example.invalid', 'Suspenso CI', 'tenant_viewer', '${hash('operator-ci-fixture-only')}', true),
  (NULL, 'global-auth@example.invalid', 'Global CI', 'super_admin', '${hash('global-ci-fixture-only')}', true);
COMMIT;`);
