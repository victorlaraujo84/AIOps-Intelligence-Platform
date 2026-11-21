DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiops_site_writer') THEN
    BEGIN
      CREATE ROLE aiops_site_writer NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_site_writer'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_site_writer', 'public', 'CREATE')
    OR has_schema_privilege('aiops_site_writer', 'aiops_auth', 'USAGE')
    OR has_any_column_privilege('aiops_site_writer', 'public.users', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('aiops_site_writer', 'public.sessions', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('aiops_site_writer', 'public.audit_logs', 'SELECT')
    OR has_table_privilege('aiops_site_writer', 'public.sites', 'DELETE, TRUNCATE, TRIGGER')
    OR EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid IN ('public.sites'::regclass, 'public.tenants'::regclass, 'public.audit_logs'::regclass)
        AND (NOT c.relrowsecurity OR c.relowner = 'aiops_site_writer'::regrole)
    )
  THEN
    RAISE EXCEPTION 'O papel aiops_site_writer tem privilégios ou RLS incompatíveis';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO aiops_site_writer;
GRANT SELECT (id, status) ON public.tenants TO aiops_site_writer;
GRANT SELECT (id, tenant_id, code, name, municipality, uf, latitude, longitude, coord_verified, criticality)
  ON public.sites TO aiops_site_writer;
GRANT INSERT (tenant_id, code, name, municipality, uf, criticality) ON public.sites TO aiops_site_writer;
GRANT UPDATE (name, municipality, uf, criticality, updated_at_utc) ON public.sites TO aiops_site_writer;
GRANT INSERT (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
  ON public.audit_logs TO aiops_site_writer;

CREATE POLICY site_writer_tenant_read ON public.tenants
  FOR SELECT TO aiops_site_writer
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY site_writer_scope ON public.sites AS RESTRICTIVE
  FOR ALL TO aiops_site_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY site_writer_audit ON public.audit_logs
  FOR INSERT TO aiops_site_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'site'
    AND action IN ('SITE_CREATED', 'SITE_UPDATED')
  );
