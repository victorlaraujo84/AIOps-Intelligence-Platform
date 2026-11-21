CREATE FUNCTION aiops_auth.select_tenant(digest text, target_tenant uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE public.sessions AS session
  SET admin_tenant_id = target_tenant
  FROM public.users AS account, public.tenants AS tenant
  WHERE session.token_hash = digest AND session.expires_at_utc > now()
    AND session.user_id = account.id AND account.role = 'super_admin' AND account.is_active
    AND tenant.id = target_tenant AND tenant.status = 'active';
  RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION aiops_auth.select_tenant(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.select_tenant(text, uuid) TO aiops_authenticator;
