-- O índice service_dependencies_tenant_service_id_idx já cobre o serviço consumidor.
CREATE INDEX service_dependencies_upstream_link_idx
  ON public.service_dependencies (tenant_id, upstream_service_id) WHERE upstream_service_id IS NOT NULL;
CREATE INDEX metric_samples_service_link_idx
  ON public.metric_samples (tenant_id, service_id) WHERE service_id IS NOT NULL;
CREATE INDEX operational_logs_service_link_idx
  ON public.operational_logs (tenant_id, service_id) WHERE service_id IS NOT NULL;
CREATE INDEX anomaly_detections_service_link_idx
  ON public.anomaly_detections (tenant_id, service_id) WHERE service_id IS NOT NULL;

GRANT DELETE ON public.services TO aiops_service_writer;

CREATE POLICY service_writer_delete_audit ON public.audit_logs
  FOR INSERT TO aiops_service_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND actor_role IN ('tenant_admin', 'super_admin')
    AND resource_type = 'service' AND action = 'SERVICE_DELETED'
  );
