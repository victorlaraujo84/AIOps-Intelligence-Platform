-- O índice único de enlaces já cobre a busca pela origem.
CREATE INDEX topology_edges_target_link_idx
  ON public.topology_edges (tenant_id, target_asset_id);
CREATE INDEX assets_parent_link_idx
  ON public.assets (tenant_id, topology_parent_id) WHERE topology_parent_id IS NOT NULL;
CREATE INDEX service_dependencies_asset_link_idx
  ON public.service_dependencies (tenant_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX canonical_events_asset_link_idx
  ON public.canonical_events (tenant_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX incidents_asset_link_idx
  ON public.incidents (tenant_id, root_asset_id) WHERE root_asset_id IS NOT NULL;
CREATE INDEX metric_samples_asset_link_idx
  ON public.metric_samples (tenant_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX operational_logs_asset_link_idx
  ON public.operational_logs (tenant_id, asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX anomaly_detections_asset_link_idx
  ON public.anomaly_detections (tenant_id, asset_id) WHERE asset_id IS NOT NULL;

GRANT DELETE ON public.assets TO aiops_asset_writer;

CREATE POLICY asset_writer_delete_audit ON public.audit_logs
  FOR INSERT TO aiops_asset_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND actor_role IN ('tenant_admin', 'super_admin')
    AND resource_type = 'asset' AND action = 'ASSET_DELETED'
  );
