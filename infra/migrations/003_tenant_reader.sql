-- Papel de leitura para transações com o tenant definido pelo backend autenticado.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiops_tenant_reader') THEN
    BEGIN
      CREATE ROLE aiops_tenant_reader NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      -- Outro banco no mesmo cluster pode ter criado o papel simultaneamente.
      NULL;
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_tenant_reader'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_tenant_reader', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Papel aiops_tenant_reader com privilégios incompatíveis';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid IN ('public.tenants'::regclass, 'public.audit_logs'::regclass)) THEN
    RAISE EXCEPTION 'Política preexistente em tenants ou audit_logs requer revisão';
  END IF;
END $$;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_reader_own_tenant ON public.tenants
  FOR SELECT TO aiops_tenant_reader
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_reader_own_audit ON public.audit_logs
  FOR SELECT TO aiops_tenant_reader
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

DO $$
DECLARE
  scoped_table regclass;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'public.concessions', 'public.locality_types', 'public.sites',
    'public.asset_categories', 'public.assets', 'public.topology_edges',
    'public.connectors', 'public.canonical_events', 'public.incidents',
    'public.services', 'public.service_dependencies', 'public.metric_samples',
    'public.operational_logs', 'public.ingestion_checkpoints',
    'public.authorized_collection_scopes', 'public.anomaly_detections'
  ]::regclass[]
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid = scoped_table AND c.relrowsecurity
        AND c.relowner <> 'aiops_tenant_reader'::regrole
    ) THEN
      RAISE EXCEPTION 'Tabela % requer RLS ativa e proprietário distinto do leitor', scoped_table;
    END IF;

    -- A política de leitura continua obrigatória com outras políticas permissivas.
    EXECUTE format(
      'CREATE POLICY tenant_reader_scope ON %s AS RESTRICTIVE FOR SELECT TO aiops_tenant_reader
       USING (tenant_id = NULLIF(current_setting(''app.current_tenant_id'', true), '''')::uuid)',
      scoped_table
    );
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public TO aiops_tenant_reader;
GRANT SELECT ON
  public.tenants, public.concessions, public.locality_types, public.sites,
  public.asset_categories, public.assets, public.topology_edges,
  public.canonical_events, public.incidents, public.services, public.service_dependencies,
  public.metric_samples, public.operational_logs, public.ingestion_checkpoints,
  public.authorized_collection_scopes, public.anomaly_detections
TO aiops_tenant_reader;

GRANT SELECT (id, tenant_id, connector_type, name, status, last_sync_at_utc)
  ON public.connectors TO aiops_tenant_reader;

GRANT SELECT (id, tenant_id, actor_role, action, resource_type, resource_id, created_at_utc)
  ON public.audit_logs TO aiops_tenant_reader;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      AND (c.relowner = 'aiops_tenant_reader'::regrole
           OR has_table_privilege('aiops_tenant_reader', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
           OR has_any_column_privilege('aiops_tenant_reader', c.oid, 'INSERT, UPDATE, REFERENCES'))
  ) OR has_any_column_privilege('aiops_tenant_reader', 'public.users', 'SELECT')
    OR has_any_column_privilege('aiops_tenant_reader', 'public.metric_samples_default', 'SELECT')
    OR has_schema_privilege('aiops_tenant_reader', 'aiops_admin', 'USAGE')
    OR EXISTS (
      SELECT 1 FROM pg_attribute a
      WHERE a.attnum > 0 AND NOT a.attisdropped
        AND (
          (a.attrelid = 'public.connectors'::regclass
            AND a.attname NOT IN ('id', 'tenant_id', 'connector_type', 'name', 'status', 'last_sync_at_utc'))
          OR (a.attrelid = 'public.audit_logs'::regclass
            AND a.attname NOT IN ('id', 'tenant_id', 'actor_role', 'action', 'resource_type', 'resource_id', 'created_at_utc'))
        )
        AND has_column_privilege('aiops_tenant_reader', a.attrelid, a.attnum, 'SELECT')
    )
  THEN
    RAISE EXCEPTION 'Privilégios preexistentes ampliam o acesso de aiops_tenant_reader';
  END IF;
END $$;
