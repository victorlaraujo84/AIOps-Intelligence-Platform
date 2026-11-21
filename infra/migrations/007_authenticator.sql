DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aiops_authenticator') THEN
    BEGIN
      CREATE ROLE aiops_authenticator NOLOGIN NOINHERIT NOSUPERUSER
        NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL;
    END;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_authenticator'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_authenticator', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Papel aiops_authenticator com privilégios incompatíveis';
  END IF;

  IF has_any_column_privilege('aiops_authenticator', 'public.users', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege('aiops_authenticator', 'public.users', 'DELETE, TRUNCATE, TRIGGER')
    OR has_any_column_privilege('aiops_authenticator', 'public.sessions', 'SELECT, INSERT, UPDATE, REFERENCES')
    OR has_table_privilege('aiops_authenticator', 'public.sessions', 'DELETE, TRUNCATE, TRIGGER')
  THEN
    RAISE EXCEPTION 'O autenticador requer acesso a usuários e sessões apenas por funções';
  END IF;
END $$;

CREATE SCHEMA aiops_auth;
REVOKE ALL ON SCHEMA aiops_auth FROM PUBLIC;
GRANT USAGE ON SCHEMA aiops_auth TO aiops_authenticator;

CREATE FUNCTION aiops_auth.find_login(candidate_email text)
RETURNS TABLE (id uuid, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT u.id, u.password_hash
  FROM public.users u
  LEFT JOIN public.tenants t ON t.id = u.tenant_id
  WHERE u.email = candidate_email AND u.is_active
    AND (u.role = 'super_admin' OR t.status = 'active');
$$;

CREATE FUNCTION aiops_auth.start_session(account_id uuid, verified_hash text, digest text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  account public.users%ROWTYPE;
BEGIN
  SELECT u.* INTO account
  FROM public.users u
  LEFT JOIN public.tenants t ON t.id = u.tenant_id
  WHERE u.id = account_id AND u.password_hash = verified_hash AND u.is_active
    AND (u.role = 'super_admin' OR t.status = 'active')
  FOR UPDATE OF u;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.sessions (user_id, user_role, tenant_id, token_hash, expires_at_utc)
  VALUES (account.id, account.role, account.tenant_id, digest, now() + interval '12 hours');

  UPDATE public.users SET last_login_utc = now() WHERE id = account.id;
  RETURN true;
END $$;

CREATE FUNCTION aiops_auth.find_session(digest text)
RETURNS TABLE (
  id uuid, email text, full_name text, role text, tenant_id uuid, active_tenant_id uuid, expires_at_utc timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT u.id, u.email, u.full_name, u.role, u.tenant_id,
         CASE WHEN active_tenant.status = 'active' THEN s.active_tenant_id END,
         s.expires_at_utc
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id
  LEFT JOIN public.tenants active_tenant ON active_tenant.id = s.active_tenant_id
  WHERE s.token_hash = digest AND s.expires_at_utc > now() AND u.is_active
    AND (u.role = 'super_admin' OR active_tenant.status = 'active');
$$;

CREATE FUNCTION aiops_auth.end_session(digest text)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM public.sessions WHERE token_hash = digest;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aiops_auth FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  aiops_auth.find_login(text),
  aiops_auth.start_session(uuid, text, text),
  aiops_auth.find_session(text),
  aiops_auth.end_session(text)
TO aiops_authenticator;
