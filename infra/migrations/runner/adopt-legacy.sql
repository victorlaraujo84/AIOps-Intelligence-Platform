-- Adoção explícita de volumes inicializados pelos SQLs anteriores ao histórico.
CREATE TEMP VIEW aiops_expected_tenant_policies AS
SELECT p.polrelid, p.polname
FROM pg_policy p
WHERE p.polcmd = '*'
  AND p.polpermissive
  AND p.polroles = ARRAY[0::oid]
  AND p.polwithcheck IS NULL
  AND pg_get_expr(p.polqual, p.polrelid)
      = $policy$(tenant_id = (NULLIF(current_setting('app.current_tenant_id'::text, true), ''::text))::uuid)$policy$
  AND NOT EXISTS (
    SELECT 1 FROM pg_policy other WHERE other.polrelid = p.polrelid AND other.oid <> p.oid
  );

WITH expected(table_name, policy) AS (
  VALUES
    ('tenants', NULL), ('users', NULL), ('audit_logs', NULL),
    ('concessions', 'tenant_isolation_concessions'),
    ('locality_types', 'tenant_isolation_locality_types'),
    ('sites', 'tenant_isolation_sites'),
    ('asset_categories', 'tenant_isolation_asset_categories'),
    ('assets', 'tenant_isolation_assets'),
    ('topology_edges', 'tenant_isolation_topology_edges'),
    ('connectors', 'tenant_isolation_connectors'),
    ('canonical_events', 'tenant_isolation_canonical_events'),
    ('incidents', 'tenant_isolation_incidents')
)
SELECT NOT EXISTS (
  SELECT 1 FROM expected e
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.oid = to_regclass('public.' || e.table_name) AND c.relkind = 'r'
    AND (e.policy IS NULL OR (c.relrowsecurity AND EXISTS (
      SELECT 1 FROM pg_temp.aiops_expected_tenant_policies p WHERE p.polrelid = c.oid AND p.polname = e.policy
    )))
  )
) AND (SELECT count(*) = 2 FROM pg_extension WHERE extname IN ('pgcrypto', 'postgis')) AS initial_matches
\gset

\if :initial_matches
\else
  DO $$ BEGIN RAISE EXCEPTION 'Schema legado incompleto ou divergente na versão 001'; END $$;
\endif

WITH expected(table_name, policy, kind) AS (
  VALUES
    ('services', 'tenant_isolation_services', 'r'),
    ('service_dependencies', 'tenant_isolation_service_deps', 'r'),
    ('metric_samples', 'tenant_isolation_metrics', 'p'),
    ('metric_samples_default', NULL, 'r'),
    ('operational_logs', 'tenant_isolation_logs', 'r'),
    ('ingestion_checkpoints', 'tenant_isolation_checkpoints', 'r'),
    ('authorized_collection_scopes', 'tenant_isolation_collection_scopes', 'r'),
    ('anomaly_detections', 'tenant_isolation_anomalies', 'r')
), columns_v2(table_name, column_name) AS (
  VALUES ('assets', 'asset_type_code'), ('assets', 'domain'), ('assets', 'georeference_mode'),
         ('assets', 'metadata_json'), ('incidents', 'impacted_services_count')
), found AS (
  SELECT count(c.oid) AS relations, count(*) FILTER (
    WHERE c.relkind::text = e.kind AND (e.policy IS NULL OR (c.relrowsecurity AND EXISTS (
      SELECT 1 FROM pg_temp.aiops_expected_tenant_policies p WHERE p.polrelid = c.oid AND p.polname = e.policy
    )))
  ) AS matching_relations
  FROM expected e LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || e.table_name)
), attributed AS (
  SELECT count(*) FILTER (WHERE a.attname IS NOT NULL) AS columns,
         bool_and(a.attnotnull) FILTER (WHERE e.column_name = 'site_id') AS requires_site
  FROM (SELECT * FROM columns_v2 UNION ALL SELECT 'assets', 'site_id') e
  LEFT JOIN pg_attribute a ON a.attrelid = to_regclass('public.' || e.table_name)
    AND a.attname = e.column_name AND NOT a.attisdropped
)
SELECT (relations > 0 OR columns > 1 OR requires_site IS FALSE) AS has_hybrid_objects,
       (matching_relations = 8 AND columns = 6 AND requires_site IS FALSE AND EXISTS (
         SELECT 1 FROM pg_inherits
         WHERE inhparent = to_regclass('public.metric_samples')
           AND inhrelid = to_regclass('public.metric_samples_default')
       )) AS has_hybrid
FROM found CROSS JOIN attributed
\gset

\if :has_hybrid_objects
  \if :has_hybrid
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Schema legado incompleto ou divergente na versão 002'; END $$;
  \endif
\endif

INSERT INTO aiops_admin.schema_migrations (version, filename, sha256, adopted)
VALUES (1, '001_initial_schema.sql', :'initial_sha', true);

\if :has_hybrid
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256, adopted)
  VALUES (2, '002_hybrid_observability.sql', :'hybrid_sha', true);
\endif
