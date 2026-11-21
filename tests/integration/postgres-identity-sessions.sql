\set ON_ERROR_STOP on
BEGIN;

-- Identidades e hashes sintéticos usados apenas neste teste descartável.
INSERT INTO tenants (id, name, slug) VALUES
  ('00000000-0000-4000-a000-000000000001', 'Tenant A de teste', 'identity-a'),
  ('00000000-0000-4000-a000-000000000002', 'Tenant B de teste', 'identity-b');

INSERT INTO users (id, tenant_id, email, full_name, role, password_hash) VALUES
  ('00000000-0000-4000-a000-000000000011', NULL, 'global@example.invalid', 'Admin de teste', 'super_admin', 'fixture-global'),
  ('00000000-0000-4000-a000-000000000012', '00000000-0000-4000-a000-000000000001',
    'tenant@example.invalid', 'Operador de teste', 'tenant_operator', 'fixture-tenant');

INSERT INTO sessions (user_id, user_role, tenant_id, token_hash, expires_at_utc)
VALUES ('00000000-0000-4000-a000-000000000012', 'tenant_operator', '00000000-0000-4000-a000-000000000001',
  repeat('a', 64), now() + interval '1 hour');
INSERT INTO sessions (user_id, user_role, token_hash, expires_at_utc)
VALUES ('00000000-0000-4000-a000-000000000011', 'super_admin', repeat('b', 64), now() + interval '1 hour');

CREATE FUNCTION pg_temp.expect_identity_constraint(statement text, expected_name text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  actual_name text;
BEGIN
  EXECUTE statement;
  RAISE EXCEPTION 'Operação deveria violar %', expected_name;
EXCEPTION WHEN check_violation OR foreign_key_violation THEN
  GET STACKED DIAGNOSTICS actual_name = CONSTRAINT_NAME;
  IF actual_name <> expected_name THEN
    RAISE EXCEPTION 'Restrição esperada %, obtida %', expected_name, actual_name;
  END IF;
END $$;

SELECT pg_temp.expect_identity_constraint($sql$
  INSERT INTO users (email, full_name, role, password_hash)
  VALUES ('invalid@example.invalid', 'Fixture incompatível', 'tenant_viewer', 'fixture-invalid')
$sql$, 'users_role_tenant_check');

SELECT pg_temp.expect_identity_constraint($sql$
  UPDATE sessions SET tenant_id = '00000000-0000-4000-a000-000000000002' WHERE token_hash = repeat('a', 64)
$sql$, 'sessions_user_tenant_fkey');

SELECT pg_temp.expect_identity_constraint($sql$
  UPDATE sessions SET user_role = 'tenant_viewer' WHERE token_hash = repeat('a', 64)
$sql$, 'sessions_user_role_fkey');

SELECT pg_temp.expect_identity_constraint($sql$
  UPDATE sessions SET admin_tenant_id = '00000000-0000-4000-a000-000000000002' WHERE token_hash = repeat('a', 64)
$sql$, 'sessions_role_scope_check');

SELECT pg_temp.expect_identity_constraint($sql$
  UPDATE sessions SET token_hash = 'fixture-sem-hash' WHERE token_hash = repeat('a', 64)
$sql$, 'sessions_token_hash_check');

SELECT pg_temp.expect_identity_constraint($sql$
  UPDATE sessions SET expires_at_utc = created_at_utc WHERE token_hash = repeat('a', 64)
$sql$, 'sessions_expiration_check');

UPDATE sessions SET admin_tenant_id = '00000000-0000-4000-a000-000000000002' WHERE token_hash = repeat('b', 64);

DO $$
BEGIN
  IF (SELECT active_tenant_id FROM sessions WHERE token_hash = repeat('a', 64))
      IS DISTINCT FROM '00000000-0000-4000-a000-000000000001'::uuid
    OR (SELECT active_tenant_id FROM sessions WHERE token_hash = repeat('b', 64))
      IS DISTINCT FROM '00000000-0000-4000-a000-000000000002'::uuid
  THEN
    RAISE EXCEPTION 'Contexto ativo incompatível com o papel da sessão';
  END IF;
  IF has_any_column_privilege('aiops_tenant_reader', 'public.sessions', 'SELECT')
    OR has_column_privilege('aiops_tenant_reader', 'public.users', 'password_hash', 'SELECT')
  THEN
    RAISE EXCEPTION 'Papel de inventário com acesso ao armazenamento de autenticação';
  END IF;
END $$;

DELETE FROM tenants WHERE slug IN ('identity-a', 'identity-b');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sessions WHERE token_hash = repeat('a', 64))
    OR NOT EXISTS (SELECT 1 FROM sessions WHERE token_hash = repeat('b', 64) AND active_tenant_id IS NULL)
  THEN
    RAISE EXCEPTION 'Sessões em estado incompatível após a remoção dos tenants de teste';
  END IF;
END $$;

ROLLBACK;
