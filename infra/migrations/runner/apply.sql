BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(189174310, 1);

CREATE SCHEMA IF NOT EXISTS aiops_admin;
REVOKE ALL ON SCHEMA aiops_admin FROM PUBLIC;

CREATE TABLE IF NOT EXISTS aiops_admin.schema_migrations (
  version INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  adopted BOOLEAN NOT NULL DEFAULT FALSE
);
REVOKE ALL ON TABLE aiops_admin.schema_migrations FROM PUBLIC;

WITH known(version, filename, sha256) AS (
  VALUES
    (1, '001_initial_schema.sql', :'initial_sha'),
    (2, '002_hybrid_observability.sql', :'hybrid_sha'),
    (3, '003_tenant_reader.sql', :'reader_sha'),
    (4, '004_tenant_links.sql', :'links_sha'),
    (5, '005_inventory_parity.sql', :'inventory_sha'),
    (6, '006_identity_sessions.sql', :'identity_sha'),
    (7, '007_authenticator.sql', :'auth_sha'),
    (8, '008_auth_tenant_selection.sql', :'selection_sha'),
    (9, '009_site_writer.sql', :'site_writer_sha'),
    (10, '010_asset_writer.sql', :'asset_writer_sha'),
    (11, '011_service_writer.sql', :'service_writer_sha'),
    (12, '012_service_dependencies.sql', :'service_dependencies_sha'),
    (13, '013_topology_edges.sql', :'topology_edges_sha'),
    (14, '014_asset_categories.sql', :'asset_categories_sha'),
    (15, '015_site_catalog.sql', :'site_catalog_sha'),
    (16, '016_site_location.sql', :'site_location_sha'),
    (17, '017_site_map_index.sql', :'site_map_sha'),
    (18, '018_auth_tenant_list.sql', :'tenant_list_sha'),
    (19, '019_tenant_user_admin.sql', :'tenant_user_admin_sha'),
    (20, '020_create_tenant.sql', :'create_tenant_sha'),
    (21, '021_concession_delete.sql', :'concession_delete_sha'),
    (22, '022_site_delete.sql', :'site_delete_sha'),
    (23, '023_asset_delete.sql', :'asset_delete_sha'),
    (24, '024_service_delete.sql', :'service_delete_sha'),
    (25, '025_legacy_operational_history.sql', :'operational_history_sha'),
    (26, '026_asset_identification.sql', :'asset_identification_sha'),
    (27, '027_incident_review.sql', :'incident_review_sha'),
    (28, '028_incident_outbox.sql', :'incident_outbox_sha')
)
SELECT NOT EXISTS (
    SELECT 1 FROM aiops_admin.schema_migrations AS stored
    LEFT JOIN known ON known.version = stored.version
    WHERE stored.filename IS DISTINCT FROM known.filename OR stored.sha256 IS DISTINCT FROM known.sha256
  ) AS history_matches,
  COALESCE(bool_or(m.version = 1), false) AS has_initial,
  COALESCE(bool_or(m.version = 2), false) AS has_hybrid,
  COALESCE(bool_or(m.version = 3), false) AS has_reader,
  COALESCE(bool_or(m.version = 4), false) AS has_links,
  COALESCE(bool_or(m.version = 5), false) AS has_inventory,
  COALESCE(bool_or(m.version = 6), false) AS has_identity,
  COALESCE(bool_or(m.version = 7), false) AS has_auth,
  COALESCE(bool_or(m.version = 8), false) AS has_selection,
  COALESCE(bool_or(m.version = 9), false) AS has_site_writer,
  COALESCE(bool_or(m.version = 10), false) AS has_asset_writer,
  COALESCE(bool_or(m.version = 11), false) AS has_service_writer,
  COALESCE(bool_or(m.version = 12), false) AS has_service_dependencies,
  COALESCE(bool_or(m.version = 13), false) AS has_topology_edges,
  COALESCE(bool_or(m.version = 14), false) AS has_asset_categories,
  COALESCE(bool_or(m.version = 15), false) AS has_site_catalog,
  COALESCE(bool_or(m.version = 16), false) AS has_site_location,
  COALESCE(bool_or(m.version = 17), false) AS has_site_map,
  COALESCE(bool_or(m.version = 18), false) AS has_tenant_list,
  COALESCE(bool_or(m.version = 19), false) AS has_tenant_user_admin,
  COALESCE(bool_or(m.version = 20), false) AS has_create_tenant,
  COALESCE(bool_or(m.version = 21), false) AS has_concession_delete,
  COALESCE(bool_or(m.version = 22), false) AS has_site_delete,
  COALESCE(bool_or(m.version = 23), false) AS has_asset_delete,
  COALESCE(bool_or(m.version = 24), false) AS has_service_delete,
  COALESCE(bool_or(m.version = 25), false) AS has_operational_history,
  COALESCE(bool_or(m.version = 26), false) AS has_asset_identification,
  COALESCE(bool_or(m.version = 27), false) AS has_incident_review,
  COALESCE(bool_or(m.version = 28), false) AS has_incident_outbox
FROM aiops_admin.schema_migrations AS m
\gset

\if :history_matches
\else
  DO $$ BEGIN RAISE EXCEPTION 'Histórico PostgreSQL incompatível ou checksum alterado'; END $$;
\endif

\if :has_incident_outbox
  \if :has_incident_review
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 028 sem versão 027'; END $$;
  \endif
\endif

\if :has_incident_review
  \if :has_asset_identification
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 027 sem versão 026'; END $$;
  \endif
\endif

\if :has_asset_identification
  \if :has_operational_history
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 026 sem versão 025'; END $$;
  \endif
\endif

\if :has_operational_history
  \if :has_service_delete
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 025 sem versão 024'; END $$;
  \endif
\endif

\if :has_service_delete
  \if :has_asset_delete
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 024 sem versão 023'; END $$;
  \endif
\endif

\if :has_asset_delete
  \if :has_site_delete
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 023 sem versão 022'; END $$;
  \endif
\endif

\if :has_site_delete
  \if :has_concession_delete
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 022 sem versão 021'; END $$;
  \endif
\endif

\if :has_concession_delete
  \if :has_create_tenant
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 021 sem versão 020'; END $$;
  \endif
\endif

\if :has_create_tenant
  \if :has_tenant_user_admin
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 020 sem versão 019'; END $$;
  \endif
\endif

\if :has_tenant_user_admin
  \if :has_tenant_list
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 019 sem versão 018'; END $$;
  \endif
\endif

\if :has_tenant_list
  \if :has_site_map
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 018 sem versão 017'; END $$;
  \endif
\endif

\if :has_site_map
  \if :has_site_location
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 017 sem versão 016'; END $$;
  \endif
\endif

\if :has_site_location
  \if :has_site_catalog
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 016 sem versão 015'; END $$;
  \endif
\endif

\if :has_site_catalog
  \if :has_asset_categories
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 015 sem versão 014'; END $$;
  \endif
\endif

\if :has_asset_categories
  \if :has_topology_edges
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 014 sem versão 013'; END $$;
  \endif
\endif

\if :has_topology_edges
  \if :has_service_dependencies
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 013 sem versão 012'; END $$;
  \endif
\endif

\if :has_service_dependencies
  \if :has_service_writer
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 012 sem versão 011'; END $$;
  \endif
\endif

\if :has_service_writer
  \if :has_asset_writer
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 011 sem versão 010'; END $$;
  \endif
\endif

\if :has_asset_writer
  \if :has_site_writer
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 010 sem versão 009'; END $$;
  \endif
\endif

\if :has_site_writer
  \if :has_selection
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 009 sem versão 008'; END $$;
  \endif
\endif

\if :has_selection
  \if :has_auth
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 008 sem versão 007'; END $$;
  \endif
\endif

\if :has_auth
  \if :has_identity
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 007 sem versão 006'; END $$;
  \endif
\endif

\if :has_identity
  \if :has_inventory
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 006 sem versão 005'; END $$;
  \endif
\endif

\if :has_inventory
  \if :has_links
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 005 sem versão 004'; END $$;
  \endif
\endif

\if :has_links
  \if :has_reader
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 004 sem versão 003'; END $$;
  \endif
\endif

\if :has_reader
  \if :has_hybrid
  \else
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 003 sem versão 002'; END $$;
  \endif
\endif

\if :has_initial
\else
  \if :has_hybrid
    DO $$ BEGIN RAISE EXCEPTION 'Histórico fora de ordem: versão 002 sem versão 001'; END $$;
  \endif

  SELECT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN (
      'tenants', 'users', 'concessions', 'locality_types', 'sites', 'asset_categories',
      'assets', 'topology_edges', 'connectors', 'canonical_events', 'incidents', 'audit_logs',
      'services', 'service_dependencies', 'metric_samples', 'metric_samples_default',
      'operational_logs', 'ingestion_checkpoints', 'authorized_collection_scopes', 'anomaly_detections'
    )
  ) AS has_legacy_objects
  \gset

  \if :has_legacy_objects
    \if :adopt_legacy
      \ir adopt-legacy.sql
    \else
      DO $$ BEGIN RAISE EXCEPTION
        'Schema legado sem histórico. Faça backup e siga o procedimento de adoção no guia de implantação';
      END $$;
    \endif
  \else
    \ir ../001_initial_schema.sql
    INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
    VALUES (1, '001_initial_schema.sql', :'initial_sha');
  \endif
\endif

\if :has_hybrid
\else
  \ir ../002_hybrid_observability.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (2, '002_hybrid_observability.sql', :'hybrid_sha');
\endif

\if :has_reader
\else
  \ir ../003_tenant_reader.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (3, '003_tenant_reader.sql', :'reader_sha');
\endif

\if :has_links
\else
  \ir ../004_tenant_links.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (4, '004_tenant_links.sql', :'links_sha');
\endif

\if :has_inventory
\else
  \ir ../005_inventory_parity.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (5, '005_inventory_parity.sql', :'inventory_sha');
\endif

\if :has_identity
\else
  \ir ../006_identity_sessions.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (6, '006_identity_sessions.sql', :'identity_sha');
\endif

\if :has_auth
\else
  \ir ../007_authenticator.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (7, '007_authenticator.sql', :'auth_sha');
\endif

\if :has_selection
\else
  \ir ../008_auth_tenant_selection.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (8, '008_auth_tenant_selection.sql', :'selection_sha');
\endif

\if :has_site_writer
\else
  \ir ../009_site_writer.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (9, '009_site_writer.sql', :'site_writer_sha');
\endif

\if :has_asset_writer
\else
  \ir ../010_asset_writer.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (10, '010_asset_writer.sql', :'asset_writer_sha');
\endif

\if :has_service_writer
\else
  \ir ../011_service_writer.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (11, '011_service_writer.sql', :'service_writer_sha');
\endif

\if :has_service_dependencies
\else
  \ir ../012_service_dependencies.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (12, '012_service_dependencies.sql', :'service_dependencies_sha');
\endif

\if :has_topology_edges
\else
  \ir ../013_topology_edges.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (13, '013_topology_edges.sql', :'topology_edges_sha');
\endif

\if :has_asset_categories
\else
  \ir ../014_asset_categories.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (14, '014_asset_categories.sql', :'asset_categories_sha');
\endif

\if :has_site_catalog
\else
  \ir ../015_site_catalog.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (15, '015_site_catalog.sql', :'site_catalog_sha');
\endif

\if :has_site_location
\else
  \ir ../016_site_location.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (16, '016_site_location.sql', :'site_location_sha');
\endif

\if :has_site_map
\else
  \ir ../017_site_map_index.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (17, '017_site_map_index.sql', :'site_map_sha');
\endif

\if :has_tenant_list
\else
  \ir ../018_auth_tenant_list.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (18, '018_auth_tenant_list.sql', :'tenant_list_sha');
\endif

\if :has_tenant_user_admin
\else
  \ir ../019_tenant_user_admin.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (19, '019_tenant_user_admin.sql', :'tenant_user_admin_sha');
\endif

\if :has_create_tenant
\else
  \ir ../020_create_tenant.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (20, '020_create_tenant.sql', :'create_tenant_sha');
\endif

\if :has_concession_delete
\else
  \ir ../021_concession_delete.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (21, '021_concession_delete.sql', :'concession_delete_sha');
\endif

\if :has_site_delete
\else
  \ir ../022_site_delete.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (22, '022_site_delete.sql', :'site_delete_sha');
\endif

\if :has_asset_delete
\else
  \ir ../023_asset_delete.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (23, '023_asset_delete.sql', :'asset_delete_sha');
\endif

\if :has_service_delete
\else
  \ir ../024_service_delete.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (24, '024_service_delete.sql', :'service_delete_sha');
\endif

\if :has_operational_history
\else
  \ir ../025_legacy_operational_history.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (25, '025_legacy_operational_history.sql', :'operational_history_sha');
\endif

\if :has_asset_identification
\else
  \ir ../026_asset_identification.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (26, '026_asset_identification.sql', :'asset_identification_sha');
\endif

\if :has_incident_review
\else
  \ir ../027_incident_review.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (27, '027_incident_review.sql', :'incident_review_sha');
\endif

\if :has_incident_outbox
\else
  \ir ../028_incident_outbox.sql
  INSERT INTO aiops_admin.schema_migrations (version, filename, sha256)
  VALUES (28, '028_incident_outbox.sql', :'incident_outbox_sha');
\endif

COMMIT;
SELECT version, filename, adopted FROM aiops_admin.schema_migrations ORDER BY version;
