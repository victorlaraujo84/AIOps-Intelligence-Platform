DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.service_dependencies'::regclass
      AND (NOT relrowsecurity OR relowner = 'aiops_service_writer'::regrole)
  ) OR has_any_column_privilege('aiops_service_writer', 'public.service_dependencies', 'UPDATE')
    OR has_table_privilege('aiops_service_writer', 'public.service_dependencies', 'TRUNCATE, TRIGGER')
  THEN
    RAISE EXCEPTION 'Privilégios ou RLS incompatíveis em service_dependencies';
  END IF;
END $$;

CREATE INDEX service_dependencies_tenant_service_id_idx
  ON public.service_dependencies (tenant_id, service_id, id);

GRANT SELECT (id, tenant_id, service_id, asset_id, upstream_service_id, dependency_role, weight, created_at_utc)
  ON public.service_dependencies TO aiops_service_writer;
GRANT INSERT (tenant_id, service_id, asset_id, upstream_service_id, dependency_role, weight)
  ON public.service_dependencies TO aiops_service_writer;
GRANT DELETE ON public.service_dependencies TO aiops_service_writer;

CREATE POLICY service_writer_dependency_scope ON public.service_dependencies AS RESTRICTIVE
  FOR ALL TO aiops_service_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY service_writer_dependency_audit ON public.audit_logs
  FOR INSERT TO aiops_service_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'service_dependency'
    AND action IN ('SERVICE_DEPENDENCY_CREATED', 'SERVICE_DEPENDENCY_DELETED')
  );
