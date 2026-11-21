-- Os vínculos compostos existentes limpam a referência ao site e preservam os registros.
CREATE INDEX assets_site_link_idx
  ON public.assets (tenant_id, site_id) WHERE site_id IS NOT NULL;
CREATE INDEX canonical_events_site_link_idx
  ON public.canonical_events (tenant_id, site_id) WHERE site_id IS NOT NULL;
CREATE INDEX incidents_site_link_idx
  ON public.incidents (tenant_id, root_site_id) WHERE root_site_id IS NOT NULL;
CREATE INDEX metric_samples_site_link_idx
  ON public.metric_samples (tenant_id, site_id) WHERE site_id IS NOT NULL;
CREATE INDEX operational_logs_site_link_idx
  ON public.operational_logs (tenant_id, site_id) WHERE site_id IS NOT NULL;

GRANT DELETE ON public.sites TO aiops_site_writer;

CREATE POLICY site_writer_delete_audit ON public.audit_logs
  FOR INSERT TO aiops_site_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND actor_role IN ('tenant_admin', 'super_admin')
    AND resource_type = 'site' AND action = 'SITE_DELETED'
  );
