-- A chave composta existente desvincula os sites e mantém o tenant.
CREATE INDEX sites_concession_link_idx
  ON public.sites (tenant_id, concession_id) WHERE concession_id IS NOT NULL;

GRANT DELETE ON public.concessions TO aiops_site_writer;

CREATE POLICY site_writer_concession_delete_audit ON public.audit_logs
  FOR INSERT TO aiops_site_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND actor_role IN ('tenant_admin', 'super_admin')
    AND resource_type = 'concession' AND action = 'CONCESSION_DELETED'
  );
