CREATE FUNCTION aiops_auth.require_tenant_user_admin(digest text, expected_tenant uuid)
RETURNS TABLE (actor_id uuid, actor_role text, tenant_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM aiops_auth.find_session(digest);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida';
  END IF;
  IF actor.role NOT IN ('super_admin', 'tenant_admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito a administradores';
  END IF;
  IF actor.active_tenant_id IS NULL OR actor.active_tenant_id IS DISTINCT FROM expected_tenant THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Tenant ativo mudou';
  END IF;
  RETURN QUERY SELECT actor.id, actor.role, actor.active_tenant_id;
END $$;

CREATE FUNCTION aiops_auth.list_tenant_users(digest text, expected_tenant uuid, after_id uuid, max_rows integer)
RETURNS TABLE (id uuid, email text, full_name text, role text, is_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT u.id, u.email, u.full_name, u.role, u.is_active
  FROM aiops_auth.require_tenant_user_admin(digest, expected_tenant) AS actor
  JOIN public.users u ON u.tenant_id = actor.tenant_id
  WHERE after_id IS NULL OR u.id > after_id
  ORDER BY u.id LIMIT LEAST(GREATEST(max_rows, 1), 101)
$$;

CREATE FUNCTION aiops_auth.create_tenant_user(
  digest text, expected_tenant uuid, new_email text, new_full_name text, new_role text, new_hash text
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  account_id uuid;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_tenant_user_admin(digest, expected_tenant);
  IF new_role IS NULL OR new_role NOT IN ('tenant_admin', 'tenant_operator', 'tenant_viewer')
     OR new_hash IS NULL OR new_hash !~ '^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$'
     OR new_email IS NULL OR new_email !~ '^[^[:space:]@]+@[^[:space:]@]+$'
     OR length(new_email) > 254 OR new_email <> lower(new_email)
     OR new_full_name IS NULL OR length(btrim(new_full_name)) NOT BETWEEN 1 AND 200
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados de usuário inválidos';
  END IF;

  INSERT INTO public.users (tenant_id, email, full_name, role, password_hash)
  VALUES (actor.tenant_id, new_email, new_full_name, new_role, new_hash)
  ON CONFLICT (email) DO NOTHING RETURNING id INTO account_id;
  IF account_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1002', MESSAGE = 'E-mail indisponível';
  END IF;

  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
  VALUES (actor.tenant_id, actor.actor_id, actor.actor_role, 'USER_CREATED', 'user', account_id::text);
  RETURN account_id;
END $$;

CREATE FUNCTION aiops_auth.set_tenant_user_active(
  digest text, expected_tenant uuid, account_id uuid, desired_active boolean
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  previous_active boolean;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_tenant_user_admin(digest, expected_tenant);
  IF account_id = actor.actor_id OR desired_active IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Alteração de status inválida';
  END IF;

  SELECT u.is_active INTO previous_active FROM public.users u
  WHERE u.tenant_id = actor.tenant_id AND u.id = account_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Usuário não encontrado';
  END IF;
  IF previous_active = desired_active THEN
    RETURN desired_active;
  END IF;

  UPDATE public.users SET is_active = desired_active WHERE id = account_id AND tenant_id = actor.tenant_id;
  IF NOT desired_active THEN
    DELETE FROM public.sessions WHERE user_id = account_id AND tenant_id = actor.tenant_id;
  END IF;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
  VALUES (actor.tenant_id, actor.actor_id, actor.actor_role,
          CASE WHEN desired_active THEN 'USER_ACTIVATED' ELSE 'USER_DEACTIVATED' END, 'user', account_id::text);
  RETURN desired_active;
END $$;

REVOKE ALL ON FUNCTION
  aiops_auth.require_tenant_user_admin(text, uuid),
  aiops_auth.list_tenant_users(text, uuid, uuid, integer),
  aiops_auth.create_tenant_user(text, uuid, text, text, text, text),
  aiops_auth.set_tenant_user_active(text, uuid, uuid, boolean)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  aiops_auth.list_tenant_users(text, uuid, uuid, integer),
  aiops_auth.create_tenant_user(text, uuid, text, text, text, text),
  aiops_auth.set_tenant_user_active(text, uuid, uuid, boolean)
TO aiops_authenticator;
