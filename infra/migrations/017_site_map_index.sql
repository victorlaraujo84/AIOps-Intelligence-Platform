-- As comparações numéricas da janela podem ser aplicadas pelo índice sob RLS.
CREATE INDEX sites_verified_map_bounds_idx
  ON public.sites (tenant_id, latitude, longitude)
  WHERE coord_verified AND geom IS NOT NULL;
