DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.asset_categories'::regclass
      AND (NOT relrowsecurity OR relowner = 'aiops_asset_writer'::regrole)
  ) OR has_any_column_privilege('aiops_asset_writer', 'public.asset_categories', 'UPDATE')
    OR has_table_privilege('aiops_asset_writer', 'public.asset_categories', 'DELETE, TRUNCATE, TRIGGER')
  THEN
    RAISE EXCEPTION 'Privilégios ou RLS incompatíveis em asset_categories';
  END IF;
END $$;

CREATE INDEX asset_categories_tenant_id_idx ON public.asset_categories (tenant_id, id);

GRANT SELECT (id, tenant_id, code, label, domain, created_at_utc)
  ON public.asset_categories TO aiops_asset_writer;
GRANT INSERT (tenant_id, code, label, domain) ON public.asset_categories TO aiops_asset_writer;
GRANT SELECT (category_id), INSERT (category_id, asset_type_code), UPDATE (category_id, asset_type_code)
  ON public.assets TO aiops_asset_writer;

CREATE POLICY asset_writer_category_scope ON public.asset_categories AS RESTRICTIVE
  FOR ALL TO aiops_asset_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY asset_writer_category_audit ON public.audit_logs
  FOR INSERT TO aiops_asset_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'asset_category'
    AND action = 'ASSET_CATEGORY_CREATED'
  );
