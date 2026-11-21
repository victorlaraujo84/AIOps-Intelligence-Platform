-- Usa tenant_id na chave de cada vínculo entre entidades operacionais.

ALTER TABLE public.asset_categories
  ADD CONSTRAINT asset_categories_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.assets
  ADD CONSTRAINT assets_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.concessions
  ADD CONSTRAINT concessions_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.connectors
  ADD CONSTRAINT connectors_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.locality_types
  ADD CONSTRAINT locality_types_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.services
  ADD CONSTRAINT services_tenant_id_id_key UNIQUE (tenant_id, id);

ALTER TABLE public.sites
  ADD CONSTRAINT sites_tenant_id_id_key UNIQUE (tenant_id, id);

-- SET NULL remove apenas a referência opcional e preserva o tenant da linha.

ALTER TABLE public.sites
  DROP CONSTRAINT sites_concession_id_fkey,
  ADD CONSTRAINT sites_concession_id_fkey FOREIGN KEY (tenant_id, concession_id)
    REFERENCES public.concessions (tenant_id, id) ON DELETE SET NULL (concession_id),
  DROP CONSTRAINT sites_locality_type_id_fkey,
  ADD CONSTRAINT sites_locality_type_id_fkey FOREIGN KEY (tenant_id, locality_type_id)
    REFERENCES public.locality_types (tenant_id, id) ON DELETE SET NULL (locality_type_id);

ALTER TABLE public.assets
  DROP CONSTRAINT assets_site_id_fkey,
  ADD CONSTRAINT assets_site_id_fkey FOREIGN KEY (tenant_id, site_id)
    REFERENCES public.sites (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT assets_category_id_fkey,
  ADD CONSTRAINT assets_category_id_fkey FOREIGN KEY (tenant_id, category_id)
    REFERENCES public.asset_categories (tenant_id, id) ON DELETE SET NULL (category_id),
  DROP CONSTRAINT assets_topology_parent_id_fkey,
  ADD CONSTRAINT assets_topology_parent_id_fkey FOREIGN KEY (tenant_id, topology_parent_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE SET NULL (topology_parent_id);

ALTER TABLE public.topology_edges
  DROP CONSTRAINT topology_edges_source_asset_id_fkey,
  ADD CONSTRAINT topology_edges_source_asset_id_fkey FOREIGN KEY (tenant_id, source_asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT topology_edges_target_asset_id_fkey,
  ADD CONSTRAINT topology_edges_target_asset_id_fkey FOREIGN KEY (tenant_id, target_asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.canonical_events
  DROP CONSTRAINT canonical_events_site_id_fkey,
  ADD CONSTRAINT canonical_events_site_id_fkey FOREIGN KEY (tenant_id, site_id)
    REFERENCES public.sites (tenant_id, id) ON DELETE SET NULL (site_id),
  DROP CONSTRAINT canonical_events_asset_id_fkey,
  ADD CONSTRAINT canonical_events_asset_id_fkey FOREIGN KEY (tenant_id, asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE SET NULL (asset_id),
  DROP CONSTRAINT canonical_events_connector_id_fkey,
  ADD CONSTRAINT canonical_events_connector_id_fkey FOREIGN KEY (tenant_id, connector_id)
    REFERENCES public.connectors (tenant_id, id) ON DELETE SET NULL (connector_id);

ALTER TABLE public.incidents
  DROP CONSTRAINT incidents_root_site_id_fkey,
  ADD CONSTRAINT incidents_root_site_id_fkey FOREIGN KEY (tenant_id, root_site_id)
    REFERENCES public.sites (tenant_id, id) ON DELETE SET NULL (root_site_id),
  DROP CONSTRAINT incidents_root_asset_id_fkey,
  ADD CONSTRAINT incidents_root_asset_id_fkey FOREIGN KEY (tenant_id, root_asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE SET NULL (root_asset_id);

ALTER TABLE public.service_dependencies
  DROP CONSTRAINT service_dependencies_service_id_fkey,
  ADD CONSTRAINT service_dependencies_service_id_fkey FOREIGN KEY (tenant_id, service_id)
    REFERENCES public.services (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT service_dependencies_asset_id_fkey,
  ADD CONSTRAINT service_dependencies_asset_id_fkey FOREIGN KEY (tenant_id, asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT service_dependencies_upstream_service_id_fkey,
  ADD CONSTRAINT service_dependencies_upstream_service_id_fkey FOREIGN KEY (tenant_id, upstream_service_id)
    REFERENCES public.services (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.metric_samples
  DROP CONSTRAINT metric_samples_asset_id_fkey,
  ADD CONSTRAINT metric_samples_asset_id_fkey FOREIGN KEY (tenant_id, asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE SET NULL (asset_id),
  DROP CONSTRAINT metric_samples_service_id_fkey,
  ADD CONSTRAINT metric_samples_service_id_fkey FOREIGN KEY (tenant_id, service_id)
    REFERENCES public.services (tenant_id, id) ON DELETE SET NULL (service_id),
  DROP CONSTRAINT metric_samples_site_id_fkey,
  ADD CONSTRAINT metric_samples_site_id_fkey FOREIGN KEY (tenant_id, site_id)
    REFERENCES public.sites (tenant_id, id) ON DELETE SET NULL (site_id),
  DROP CONSTRAINT metric_samples_connector_id_fkey,
  ADD CONSTRAINT metric_samples_connector_id_fkey FOREIGN KEY (tenant_id, connector_id)
    REFERENCES public.connectors (tenant_id, id) ON DELETE SET NULL (connector_id);

ALTER TABLE public.operational_logs
  DROP CONSTRAINT operational_logs_asset_id_fkey,
  ADD CONSTRAINT operational_logs_asset_id_fkey FOREIGN KEY (tenant_id, asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE SET NULL (asset_id),
  DROP CONSTRAINT operational_logs_service_id_fkey,
  ADD CONSTRAINT operational_logs_service_id_fkey FOREIGN KEY (tenant_id, service_id)
    REFERENCES public.services (tenant_id, id) ON DELETE SET NULL (service_id),
  DROP CONSTRAINT operational_logs_site_id_fkey,
  ADD CONSTRAINT operational_logs_site_id_fkey FOREIGN KEY (tenant_id, site_id)
    REFERENCES public.sites (tenant_id, id) ON DELETE SET NULL (site_id),
  DROP CONSTRAINT operational_logs_connector_id_fkey,
  ADD CONSTRAINT operational_logs_connector_id_fkey FOREIGN KEY (tenant_id, connector_id)
    REFERENCES public.connectors (tenant_id, id) ON DELETE SET NULL (connector_id);

ALTER TABLE public.ingestion_checkpoints
  DROP CONSTRAINT ingestion_checkpoints_connector_id_fkey,
  ADD CONSTRAINT ingestion_checkpoints_connector_id_fkey FOREIGN KEY (tenant_id, connector_id)
    REFERENCES public.connectors (tenant_id, id) ON DELETE CASCADE;

ALTER TABLE public.anomaly_detections
  DROP CONSTRAINT anomaly_detections_asset_id_fkey,
  ADD CONSTRAINT anomaly_detections_asset_id_fkey FOREIGN KEY (tenant_id, asset_id)
    REFERENCES public.assets (tenant_id, id) ON DELETE SET NULL (asset_id),
  DROP CONSTRAINT anomaly_detections_service_id_fkey,
  ADD CONSTRAINT anomaly_detections_service_id_fkey FOREIGN KEY (tenant_id, service_id)
    REFERENCES public.services (tenant_id, id) ON DELETE SET NULL (service_id);
