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
    (11, '011_service_writer.sql', :'service_writer_sha')
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
  COALESCE(bool_or(m.version = 11), false) AS has_service_writer
FROM aiops_admin.schema_migrations AS m
\gset

\if :history_matches
\else
  DO $$ BEGIN RAISE EXCEPTION 'Histórico PostgreSQL incompatível ou checksum alterado'; END $$;
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

COMMIT;
SELECT version, filename, adopted FROM aiops_admin.schema_migrations ORDER BY version;
