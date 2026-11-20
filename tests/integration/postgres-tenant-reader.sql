\set ON_ERROR_STOP on
BEGIN;

-- Fixtures exclusivas do teste em banco descartável.
INSERT INTO tenants (id, name, slug) VALUES
  ('00000000-0000-4000-8000-000000000001', 'Fixture A', 'fixture-a'),
  ('00000000-0000-4000-8000-000000000002', 'Fixture B', 'fixture-b');

INSERT INTO sites (tenant_id, code, name)
  SELECT id, slug, name FROM tenants WHERE slug IN ('fixture-a', 'fixture-b');

INSERT INTO metric_samples (tenant_id, idempotency_key, metric_name, value_num, unit, observed_at_utc, source)
  SELECT id, slug, 'fixture.metric', 1, 'count', now(), 'fixture'
  FROM tenants WHERE slug IN ('fixture-a', 'fixture-b');

INSERT INTO connectors (tenant_id, connector_type, name, encrypted_credentials)
  SELECT id, 'webhook_csv', slug, 'fixture-only'
  FROM tenants WHERE slug IN ('fixture-a', 'fixture-b');

INSERT INTO audit_logs (tenant_id, action, resource_type)
  SELECT id, slug, 'fixture' FROM tenants WHERE slug IN ('fixture-a', 'fixture-b');
INSERT INTO audit_logs (action, resource_type) VALUES ('fixture-global', 'fixture');

SET LOCAL ROLE aiops_tenant_reader;

DO $$
BEGIN
  IF current_user <> 'aiops_tenant_reader'
    OR EXISTS (SELECT 1 FROM tenants)
    OR EXISTS (SELECT 1 FROM sites)
    OR EXISTS (SELECT 1 FROM metric_samples)
    OR EXISTS (SELECT id FROM connectors)
    OR EXISTS (SELECT id FROM audit_logs)
  THEN
    RAISE EXCEPTION 'As leituras sem contexto devem retornar zero linhas';
  END IF;
END $$;

SELECT set_config('app.current_tenant_id', '00000000-0000-4000-8000-000000000001', true);

DO $$
BEGIN
  IF (SELECT array_agg(slug) FROM tenants) IS DISTINCT FROM ARRAY['fixture-a']
    OR (SELECT array_agg(code) FROM sites) IS DISTINCT FROM ARRAY['fixture-a']
    OR (SELECT array_agg(idempotency_key) FROM metric_samples) IS DISTINCT FROM ARRAY['fixture-a']
    OR (SELECT array_agg(name) FROM connectors) IS DISTINCT FROM ARRAY['fixture-a']
    OR (SELECT array_agg(action) FROM audit_logs) IS DISTINCT FROM ARRAY['fixture-a']
  THEN
    RAISE EXCEPTION 'O contexto A deve retornar apenas seu próprio tenant';
  END IF;

  IF has_any_column_privilege(current_user, 'public.users', 'SELECT')
    OR has_column_privilege(current_user, 'public.connectors', 'encrypted_credentials', 'SELECT')
    OR has_column_privilege(current_user, 'public.audit_logs', 'details_json', 'SELECT')
    OR has_any_column_privilege(current_user, 'public.metric_samples_default', 'SELECT')
    OR has_schema_privilege(current_user, 'aiops_admin', 'USAGE')
    OR has_table_privilege(current_user, 'public.sites', 'INSERT, UPDATE, DELETE')
  THEN
    RAISE EXCEPTION 'O papel de leitura tem permissões fora do contrato';
  END IF;
END $$;

SELECT set_config('app.current_tenant_id', '00000000-0000-4000-8000-000000000002', true);

DO $$
BEGIN
  IF (SELECT array_agg(slug) FROM tenants) IS DISTINCT FROM ARRAY['fixture-b']
    OR (SELECT array_agg(code) FROM sites) IS DISTINCT FROM ARRAY['fixture-b']
    OR (SELECT array_agg(idempotency_key) FROM metric_samples) IS DISTINCT FROM ARRAY['fixture-b']
    OR (SELECT array_agg(name) FROM connectors) IS DISTINCT FROM ARRAY['fixture-b']
    OR (SELECT array_agg(action) FROM audit_logs) IS DISTINCT FROM ARRAY['fixture-b']
  THEN
    RAISE EXCEPTION 'O contexto B deve retornar apenas seu próprio tenant';
  END IF;
END $$;

ROLLBACK;

BEGIN;
SET LOCAL ROLE aiops_tenant_reader;
DO $$
BEGIN
  IF NULLIF(current_setting('app.current_tenant_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'O contexto de tenant vazou para a próxima transação';
  END IF;
END $$;
ROLLBACK;
