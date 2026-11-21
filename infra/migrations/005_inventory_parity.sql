-- A taxonomia e os ativos seguem as regras do inventário SQLite.
ALTER TABLE public.asset_categories
  DROP CONSTRAINT asset_categories_domain_check,
  ALTER COLUMN domain SET DEFAULT 'infra';

ALTER TABLE public.assets
  DROP CONSTRAINT assets_site_id_fkey,
  ADD CONSTRAINT assets_site_id_fkey FOREIGN KEY (tenant_id, site_id)
    REFERENCES public.sites (tenant_id, id) ON DELETE SET NULL (site_id),
  ADD CONSTRAINT assets_georeference_mode_check
    CHECK (georeference_mode IN ('required', 'optional', 'none'));
