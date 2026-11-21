GRANT SELECT (address, cep, coord_precision),
      INSERT (address, cep),
      UPDATE (address, cep, latitude, longitude, coord_precision, coord_verified, geom)
  ON public.sites TO aiops_site_writer;

GRANT INSERT (details_json) ON public.audit_logs TO aiops_site_writer;

CREATE POLICY site_writer_location_audit ON public.audit_logs
  FOR INSERT TO aiops_site_writer
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid
    AND actor_user_id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
    AND resource_type = 'site'
    AND action = 'SITE_COORDS_VERIFIED'
  );
