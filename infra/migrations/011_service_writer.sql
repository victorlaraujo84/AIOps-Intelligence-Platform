DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiops_service_writer') THEN
    BEGIN
      CREATE ROLE aiops_service_writer NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_service_writer'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_service_writer', 'public', 'CREATE')
    OR has_schema_privilege('aiops_service_writer', 'aiops_auth', 'USAGE')
    OR has_any_column_privilege('aiops_service_writer', 'public.users', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('aiops_service_writer', 'public.sessions', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('aiops_service_writer', 'public.audit_logs', 'SELECT')
    OR has_any_column_privilege('aiops_service_writer', 'public.service_dependencies', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege('aiops_service_writer', 'public.service_dependencies', 'DELETE, TRUNCATE, TRIGGER')
    OR has_table_privilege('aiops_service_writer', 'public.services', 'DELETE, TRUNCATE, TRIGGER')
    OR EXISTS (
      SELECT 1 FROM pg_class c
      WHERE c.oid IN ('public.services'::regclass, 'public.tenants'::regclass, 'public.audit_logs'::regclass)
        AND (NOT c.relrowsecurity OR c.relowner = 'aiops_service_writer'::regrole)
    )
  THEN
    RAISE EXCEPTION 'O papel aiops_service_writer tem privilégios ou RLS incompatíveis';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO aiops_service_writer;
GRANT SELECT (id, status) ON public.tenants TO aiops_service_writer;
GRANT SELECT (id, tenant_id, code, name, domain, criticality, owner_team, sla_target_pct, operational_state, description)
  ON public.services TO aiops_service_writer;
GRANT INSERT (tenant_id, code, name, domain, criticality, owner_team, sla_target_pct, description)
  ON public.services TO aiops_service_writer;
GRANT UPDATE (name, domain, criticality, owner_team, sla_target_pct, description, updated_at_utc)
  ON public.services TO aiops_service_writer;
GRANT INSERT (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
  ON public.audit_logs TO aiops_service_writer;

CREATE POLICY service_writer_tenant_read ON public.tenants
  FOR SELECT TO aiops_service_writer
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY service_writer_scope ON public.services AS RESTRICTIVE
  FOR ALL TO aiops_service_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY service_writer_audit ON public.audit_logs
  FOR INSERT TO aiops_service_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'service'
    AND action IN ('SERVICE_CREATED', 'SERVICE_UPDATED')
  );
