CREATE FUNCTION aiops_auth.list_tenants(digest text, after_id uuid, max_rows integer)
RETURNS TABLE (id uuid, name text, slug text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT tenant.id, tenant.name, tenant.slug
  FROM aiops_auth.find_session(digest) AS identity
  JOIN public.tenants AS tenant
    ON (identity.role = 'super_admin' OR tenant.id = identity.tenant_id)
  WHERE tenant.status = 'active' AND (after_id IS NULL OR tenant.id > after_id)
  ORDER BY tenant.id
  LIMIT LEAST(GREATEST(max_rows, 0), 101)
$$;

REVOKE ALL ON FUNCTION aiops_auth.list_tenants(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.list_tenants(text, uuid, integer) TO aiops_authenticator;
