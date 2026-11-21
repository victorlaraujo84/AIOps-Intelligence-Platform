CREATE FUNCTION aiops_auth.create_tenant(digest text, new_name text, new_slug text, new_document text)
RETURNS TABLE (id uuid, name text, slug text, active_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  new_id uuid;
BEGIN
  SELECT s.id AS session_id, u.id AS actor_id, u.role,
         CASE WHEN t.status = 'active' THEN s.admin_tenant_id END AS active_id
  INTO actor
  FROM public.sessions s
  JOIN public.users u ON u.id = s.user_id
  LEFT JOIN public.tenants t ON t.id = s.active_tenant_id
  WHERE s.token_hash = digest AND s.expires_at_utc > now() AND u.is_active
  FOR UPDATE OF s;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida';
  END IF;
  IF actor.role <> 'super_admin' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito a administradores globais';
  END IF;
  IF new_name IS NULL OR length(btrim(new_name)) NOT BETWEEN 2 AND 200
     OR new_slug IS NULL OR length(new_slug) > 200 OR new_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
     OR length(new_document) > 80
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados de tenant inválidos';
  END IF;

  INSERT INTO public.tenants AS tenant (name, slug, document)
  VALUES (btrim(new_name), new_slug, NULLIF(btrim(new_document), ''))
  ON CONFLICT ON CONSTRAINT tenants_slug_key DO NOTHING RETURNING tenant.id INTO new_id;
  IF new_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P1004', MESSAGE = 'Slug indisponível';
  END IF;

  -- Catálogos estruturais do SQLite, fixados nesta versão da migração.
  INSERT INTO public.locality_types (tenant_id, code, label, description) VALUES
    (new_id, 'SEDE', 'Sede Administrativa / NOC', 'Unidade central corporativa ou NOC'),
    (new_id, 'LOJA', 'Loja / Atendimento', 'Ponto comercial ou atendimento presencial'),
    (new_id, 'ETA', 'ETA (Estação de Tratamento de Água)', 'Infraestrutura operacional de água'),
    (new_id, 'ETE', 'ETE (Estação de Tratamento de Esgoto)', 'Infraestrutura operacional de esgoto'),
    (new_id, 'ELEVATORIA', 'Estação Elevatória', 'Estação de bombeamento e recalque'),
    (new_id, 'SUBESTACAO', 'Subestação Elétrica', 'Subestação de energia ou média tensão'),
    (new_id, 'TORRE_RADIO', 'Torre / Rádio Enlace', 'Repetidora, torre de telecom ou rádio enlace'),
    (new_id, 'CENTRO_DIST', 'Centro de Distribuição', 'Centro logístico ou operacional'),
    (new_id, 'DATACENTER_CLOUD', 'Datacenter / Região Cloud', 'Ambiente lógico ou datacenter TI');
  INSERT INTO public.asset_categories (tenant_id, code, label, domain) VALUES
    (new_id, 'router', 'Roteador', 'rede'),
    (new_id, 'switch', 'Switch', 'rede'),
    (new_id, 'firewall', 'Firewall', 'rede'),
    (new_id, 'radio_link', 'Rádio Enlace', 'rede'),
    (new_id, 'olt', 'OLT GPON', 'rede'),
    (new_id, 'access_point', 'Access Point', 'rede'),
    (new_id, 'server', 'Servidor / VM', 'ti'),
    (new_id, 'database', 'Banco de Dados', 'ti'),
    (new_id, 'application_node', 'Aplicação / API', 'ti'),
    (new_id, 'iot_gateway', 'Gateway IoT', 'iot'),
    (new_id, 'iot_sensor', 'Sensor IoT', 'iot'),
    (new_id, 'ups', 'UPS / Nobreak', 'energia'),
    (new_id, 'generator', 'Grupo Gerador', 'energia'),
    (new_id, 'weather_station', 'Estação Ambiental', 'ambiente');

  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
  VALUES (new_id, actor.actor_id, actor.role, 'TENANT_CREATED', 'tenant', new_id::text,
          jsonb_build_object('slug', new_slug));

  IF actor.active_id IS NULL THEN
    UPDATE public.sessions SET admin_tenant_id = new_id WHERE sessions.id = actor.session_id;
  END IF;
  RETURN QUERY SELECT new_id, btrim(new_name), new_slug, COALESCE(actor.active_id, new_id);
END $$;

REVOKE ALL ON FUNCTION aiops_auth.create_tenant(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.create_tenant(text, text, text, text) TO aiops_authenticator;
