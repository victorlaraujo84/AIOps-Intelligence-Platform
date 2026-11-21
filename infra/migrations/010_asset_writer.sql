DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiops_asset_writer') THEN
    BEGIN
      CREATE ROLE aiops_asset_writer NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_asset_writer'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_asset_writer', 'public', 'CREATE')
    OR has_schema_privilege('aiops_asset_writer', 'aiops_auth', 'USAGE')
    OR has_any_column_privilege('aiops_asset_writer', 'public.users', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('aiops_asset_writer', 'public.sessions', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('aiops_asset_writer', 'public.audit_logs', 'SELECT')
    OR has_any_column_privilege('aiops_asset_writer', 'public.sites', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege('aiops_asset_writer', 'public.sites', 'DELETE, TRUNCATE, TRIGGER')
    OR has_table_privilege('aiops_asset_writer', 'public.assets', 'DELETE, TRUNCATE, TRIGGER')
    OR EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid IN ('public.assets'::regclass, 'public.tenants'::regclass, 'public.audit_logs'::regclass)
        AND (NOT c.relrowsecurity OR c.relowner = 'aiops_asset_writer'::regrole)
    )
  THEN
    RAISE EXCEPTION 'O papel aiops_asset_writer tem privilégios ou RLS incompatíveis';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO aiops_asset_writer;
GRANT SELECT (id, status) ON public.tenants TO aiops_asset_writer;
GRANT SELECT (id, tenant_id, site_id, name, hostname, domain, georeference_mode, asset_type_code, criticality, operational_state)
  ON public.assets TO aiops_asset_writer;
GRANT INSERT (tenant_id, site_id, name, hostname, domain, georeference_mode, criticality)
  ON public.assets TO aiops_asset_writer;
GRANT UPDATE (site_id, name, hostname, domain, georeference_mode, criticality, updated_at_utc)
  ON public.assets TO aiops_asset_writer;
GRANT INSERT (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
  ON public.audit_logs TO aiops_asset_writer;

CREATE POLICY asset_writer_tenant_read ON public.tenants
  FOR SELECT TO aiops_asset_writer
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY asset_writer_scope ON public.assets AS RESTRICTIVE
  FOR ALL TO aiops_asset_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY asset_writer_audit ON public.audit_logs
  FOR INSERT TO aiops_asset_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'asset'
    AND action IN ('ASSET_CREATED', 'ASSET_UPDATED')
  );
