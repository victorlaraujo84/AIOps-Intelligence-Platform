\set ON_ERROR_STOP on
BEGIN;

-- Fixtures exclusivas do teste em banco descartável.
INSERT INTO tenants (id, name, slug) VALUES
  ('00000000-0000-4000-9000-000000000001', 'Tenant A de teste', 'links-a'),
  ('00000000-0000-4000-9000-000000000002', 'Tenant B de teste', 'links-b');

INSERT INTO sites (id, tenant_id, code, name) VALUES
  ('00000000-0000-4000-9000-000000000011', '00000000-0000-4000-9000-000000000001', 'links-site-a', 'Site A de teste'),
  ('00000000-0000-4000-9000-000000000012', '00000000-0000-4000-9000-000000000002', 'links-site-b', 'Site B de teste');

INSERT INTO assets (id, tenant_id, site_id, name) VALUES
  ('00000000-0000-4000-9000-000000000021', '00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000011', 'Asset A de teste'),
  ('00000000-0000-4000-9000-000000000022', '00000000-0000-4000-9000-000000000002', '00000000-0000-4000-9000-000000000012', 'Asset B de teste');

INSERT INTO connectors (id, tenant_id, connector_type, name) VALUES
  ('00000000-0000-4000-9000-000000000031', '00000000-0000-4000-9000-000000000001', 'webhook_csv', 'Conector A de teste'),
  ('00000000-0000-4000-9000-000000000032', '00000000-0000-4000-9000-000000000002', 'webhook_csv', 'Conector B de teste');

INSERT INTO operational_logs (tenant_id, site_id, idempotency_key, message, observed_at_utc, source)
VALUES ('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000011', 'fixture-log', 'Log de teste', now(), 'fixture');

INSERT INTO metric_samples (tenant_id, site_id, asset_id, connector_id, idempotency_key, metric_name, value_num, unit, observed_at_utc, source)
VALUES ('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000011',
  '00000000-0000-4000-9000-000000000021', '00000000-0000-4000-9000-000000000031',
  'fixture-metric', 'fixture.metric', 1, 'count', now(), 'fixture');

INSERT INTO ingestion_checkpoints (tenant_id, connector_id, cursor_key, cursor_value)
VALUES ('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000031', 'fixture-cursor', '1');

CREATE FUNCTION pg_temp.expect_tenant_fk(statement text, expected_key text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  actual_key text;
BEGIN
  EXECUTE statement;
  RAISE EXCEPTION 'Vínculo entre tenants aceito por %', expected_key;
EXCEPTION WHEN foreign_key_violation THEN
  GET STACKED DIAGNOSTICS actual_key = CONSTRAINT_NAME;
  IF actual_key <> expected_key THEN
    RAISE EXCEPTION 'FK esperada %, obtida %', expected_key, actual_key;
  END IF;
END $$;

SELECT pg_temp.expect_tenant_fk($sql$
  UPDATE assets SET site_id = '00000000-0000-4000-9000-000000000012' WHERE id = '00000000-0000-4000-9000-000000000021'
$sql$, 'assets_site_id_fkey');

SELECT pg_temp.expect_tenant_fk($sql$
  INSERT INTO topology_edges (tenant_id, source_asset_id, target_asset_id, link_type)
  VALUES ('00000000-0000-4000-9000-000000000001', '00000000-0000-4000-9000-000000000021',
    '00000000-0000-4000-9000-000000000022', 'fixture')
$sql$, 'topology_edges_target_asset_id_fkey');

SELECT pg_temp.expect_tenant_fk($sql$
  UPDATE operational_logs SET tenant_id = '00000000-0000-4000-9000-000000000002' WHERE idempotency_key = 'fixture-log'
$sql$, 'operational_logs_site_id_fkey');

SELECT pg_temp.expect_tenant_fk($sql$
  UPDATE metric_samples SET connector_id = '00000000-0000-4000-9000-000000000032' WHERE idempotency_key = 'fixture-metric'
$sql$, 'metric_samples_connector_id_fkey');

SELECT pg_temp.expect_tenant_fk($sql$
  UPDATE ingestion_checkpoints SET connector_id = '00000000-0000-4000-9000-000000000032' WHERE cursor_key = 'fixture-cursor'
$sql$, 'ingestion_checkpoints_connector_id_fkey');

DELETE FROM sites WHERE id = '00000000-0000-4000-9000-000000000011';
DELETE FROM connectors WHERE id = '00000000-0000-4000-9000-000000000031';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operational_logs WHERE idempotency_key = 'fixture-log'
      AND tenant_id = '00000000-0000-4000-9000-000000000001' AND site_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM metric_samples WHERE idempotency_key = 'fixture-metric'
      AND tenant_id = '00000000-0000-4000-9000-000000000001'
      AND site_id IS NULL AND asset_id = '00000000-0000-4000-9000-000000000021' AND connector_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM assets WHERE id = '00000000-0000-4000-9000-000000000021' AND site_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1 FROM assets WHERE id = '00000000-0000-4000-9000-000000000022'
  ) OR EXISTS (
    SELECT 1 FROM ingestion_checkpoints WHERE cursor_key = 'fixture-cursor'
  ) THEN
    RAISE EXCEPTION 'Ações de remoção da FK deixaram dados em estado incorreto';
  END IF;

  IF (SELECT count(*)
      FROM pg_constraint c
      JOIN pg_attribute child ON child.attrelid = c.conrelid AND child.attnum = c.conkey[1]
      JOIN pg_attribute parent ON parent.attrelid = c.confrelid AND parent.attnum = c.confkey[1]
      WHERE c.contype = 'f' AND c.conparentid = 0 AND c.convalidated AND cardinality(c.conkey) = 2
        AND c.connamespace = 'public'::regnamespace
        AND child.attname = 'tenant_id' AND parent.attname = 'tenant_id') <> 29
  THEN
    RAISE EXCEPTION 'Esperadas 29 FKs operacionais validadas com tenant_id';
  END IF;
END $$;
ROLLBACK;
