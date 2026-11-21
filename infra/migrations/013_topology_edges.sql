DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.topology_edges'::regclass
      AND (NOT relrowsecurity OR relowner = 'aiops_asset_writer'::regrole)
  ) OR has_any_column_privilege('aiops_asset_writer', 'public.topology_edges', 'UPDATE')
    OR has_table_privilege('aiops_asset_writer', 'public.topology_edges', 'TRUNCATE, TRIGGER')
  THEN
    RAISE EXCEPTION 'Privilégios ou RLS incompatíveis em topology_edges';
  END IF;
END $$;

CREATE INDEX topology_edges_tenant_id_idx
  ON public.topology_edges (tenant_id, id);

GRANT SELECT (id, tenant_id, source_asset_id, target_asset_id, link_type, provider_name, capacity_mbps, is_redundant, created_at_utc)
  ON public.topology_edges TO aiops_asset_writer;
GRANT INSERT (tenant_id, source_asset_id, target_asset_id, link_type, provider_name, capacity_mbps, is_redundant)
  ON public.topology_edges TO aiops_asset_writer;
GRANT DELETE ON public.topology_edges TO aiops_asset_writer;

CREATE POLICY asset_writer_topology_scope ON public.topology_edges AS RESTRICTIVE
  FOR ALL TO aiops_asset_writer
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY asset_writer_topology_audit ON public.audit_logs
  FOR INSERT TO aiops_asset_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'topology_edge'
    AND action IN ('TOPOLOGY_EDGE_CREATED', 'TOPOLOGY_EDGE_DELETED')
  );
