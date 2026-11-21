DO $$
DECLARE
  catalog regclass;
BEGIN
  FOREACH catalog IN ARRAY ARRAY['public.concessions'::regclass, 'public.locality_types'::regclass]
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class
      WHERE oid = catalog AND (NOT relrowsecurity OR relowner = 'aiops_site_writer'::regrole)
    ) OR has_any_column_privilege('aiops_site_writer', catalog, 'UPDATE')
      OR has_table_privilege('aiops_site_writer', catalog, 'DELETE, TRUNCATE, TRIGGER')
    THEN
      RAISE EXCEPTION 'Privilégios ou RLS incompatíveis em %', catalog;
    END IF;
  END LOOP;
END $$;

CREATE INDEX concessions_tenant_id_idx ON public.concessions (tenant_id, id);
CREATE INDEX locality_types_tenant_id_idx ON public.locality_types (tenant_id, id);

GRANT SELECT (id, tenant_id, code, name, region, description, created_at_utc),
      INSERT (tenant_id, code, name, region, description)
  ON public.concessions TO aiops_site_writer;
GRANT SELECT (id, tenant_id, code, label, description, created_at_utc),
      INSERT (tenant_id, code, label, description)
  ON public.locality_types TO aiops_site_writer;
GRANT SELECT (concession_id, locality_type_id),
      INSERT (concession_id, locality_type_id),
      UPDATE (concession_id, locality_type_id)
  ON public.sites TO aiops_site_writer;

CREATE POLICY site_writer_concession_scope ON public.concessions AS RESTRICTIVE
  FOR ALL TO aiops_site_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY site_writer_locality_type_scope ON public.locality_types AS RESTRICTIVE
  FOR ALL TO aiops_site_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY site_writer_catalog_audit ON public.audit_logs
  FOR INSERT TO aiops_site_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND ((resource_type = 'concession' AND action = 'CONCESSION_CREATED')
      OR (resource_type = 'locality_type' AND action = 'LOCALITY_TYPE_CREATED'))
  );
