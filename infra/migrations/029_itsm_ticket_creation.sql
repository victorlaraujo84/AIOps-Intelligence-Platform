DO $$
BEGIN
  BEGIN
    CREATE ROLE aiops_itsm_worker NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_itsm_worker'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_itsm_worker', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Papel aiops_itsm_worker com privilégios incompatíveis';
  END IF;
END $$;

GRANT USAGE ON SCHEMA aiops_notifications TO aiops_itsm_worker;

CREATE TABLE aiops_notifications.itsm_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  provider text NOT NULL CHECK (provider IN ('glpi', 'servicenow', 'jira-service-management', 'topdesk')),
  enabled boolean NOT NULL DEFAULT false,
  create_ticket_verified_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (NOT enabled OR create_ticket_verified_at IS NOT NULL)
);

CREATE TABLE aiops_notifications.itsm_ticket_creations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  integration_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'PROCESSING', 'RETRY_SCHEDULED', 'SUCCEEDED', 'FAILED', 'NEEDS_RECONCILIATION')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  created_at_utc timestamptz NOT NULL DEFAULT statement_timestamp(),
  next_attempt_at_utc timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_token uuid,
  lease_expires_at_utc timestamptz,
  last_error text CHECK (last_error IN (
    'AUTH', 'PERMISSION', 'NOT_FOUND', 'VALIDATION', 'RATE_LIMIT', 'REMOTE_ERROR',
    'NETWORK', 'NEEDS_RECONCILIATION', 'NOT_SUPPORTED', 'NOT_CONFIGURED', 'LEASE_EXPIRED', 'LINK_CONFLICT'
  )),
  external_id text CHECK (external_id ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'),
  external_reference text CHECK (length(external_reference) <= 128),
  confirmed_at_utc timestamptz,
  FOREIGN KEY (tenant_id, incident_id) REFERENCES public.incidents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, integration_id) REFERENCES aiops_notifications.itsm_integrations (tenant_id, id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (tenant_id, incident_id, integration_id),
  UNIQUE (tenant_id, integration_id, external_id),
  CHECK ((state = 'SUCCEEDED') = (external_id IS NOT NULL AND confirmed_at_utc IS NOT NULL)),
  CHECK (
    (state = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
    OR (state <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at_utc IS NULL)
  )
);

ALTER TABLE aiops_notifications.itsm_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiops_notifications.itsm_ticket_creations ENABLE ROW LEVEL SECURITY;
CREATE INDEX itsm_creations_ready_idx ON aiops_notifications.itsm_ticket_creations (next_attempt_at_utc, id)
  WHERE state IN ('PENDING', 'RETRY_SCHEDULED');
CREATE INDEX itsm_creations_expired_idx ON aiops_notifications.itsm_ticket_creations (lease_expires_at_utc, id)
  WHERE state = 'PROCESSING';

CREATE FUNCTION aiops_auth.require_itsm_tenant(digest text, expected_tenant uuid)
RETURNS TABLE (actor_id uuid, actor_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
BEGIN
  SELECT * INTO actor FROM aiops_auth.find_session(digest);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida';
  END IF;
  IF actor.active_tenant_id IS NULL OR actor.active_tenant_id IS DISTINCT FROM expected_tenant THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Tenant ativo mudou';
  END IF;
  RETURN QUERY SELECT actor.id, actor.role;
END $$;

CREATE FUNCTION aiops_auth.list_incident_itsm(digest text, expected_tenant uuid, requested_incident uuid)
RETURNS TABLE (integration_id uuid, name text, provider text, can_create boolean, operation_id uuid,
  state text, external_id text, external_reference text, last_error text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM aiops_auth.require_itsm_tenant(digest, expected_tenant);
  IF NOT EXISTS (
    SELECT 1 FROM public.incidents i WHERE i.tenant_id = expected_tenant AND i.id = requested_incident
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Incidente não encontrado';
  END IF;
  RETURN QUERY
  SELECT d.id, d.name, d.provider, d.enabled, c.id, c.state, c.external_id, c.external_reference, c.last_error
  FROM aiops_notifications.itsm_integrations d
  LEFT JOIN aiops_notifications.itsm_ticket_creations c
    ON c.tenant_id = d.tenant_id AND c.integration_id = d.id AND c.incident_id = requested_incident
  WHERE d.tenant_id = expected_tenant AND (d.enabled OR c.id IS NOT NULL)
  ORDER BY d.name, d.id;
END $$;

CREATE FUNCTION aiops_auth.request_itsm_creation(
  digest text, expected_tenant uuid, requested_incident uuid, requested_integration uuid
)
RETURNS TABLE (operation_id uuid, state text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  queued_id uuid;
BEGIN
  PERFORM 1 FROM public.sessions s WHERE s.token_hash = digest FOR UPDATE;
  SELECT * INTO STRICT actor FROM aiops_auth.require_itsm_tenant(digest, expected_tenant);
  IF actor.actor_role NOT IN ('super_admin', 'tenant_admin', 'tenant_operator') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Permissão insuficiente';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.incidents i WHERE i.tenant_id = expected_tenant AND i.id = requested_incident
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Incidente não encontrado';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM aiops_notifications.itsm_integrations d
    WHERE d.tenant_id = expected_tenant AND d.id = requested_integration AND d.enabled
    FOR SHARE
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1020', MESSAGE = 'Destino ITSM indisponível';
  END IF;

  INSERT INTO aiops_notifications.itsm_ticket_creations (tenant_id, incident_id, integration_id)
    VALUES (expected_tenant, requested_incident, requested_integration)
  ON CONFLICT (tenant_id, incident_id, integration_id) DO NOTHING RETURNING id INTO queued_id;

  IF queued_id IS NOT NULL THEN
    INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
      VALUES (expected_tenant, actor.actor_id, actor.actor_role, 'ITSM_TICKET_REQUESTED', 'incident',
              requested_incident::text, jsonb_build_object('operation_id', queued_id, 'integration_id', requested_integration));
  END IF;
  RETURN QUERY SELECT c.id, c.state FROM aiops_notifications.itsm_ticket_creations c
    WHERE c.tenant_id = expected_tenant AND c.incident_id = requested_incident AND c.integration_id = requested_integration;
END $$;

CREATE FUNCTION aiops_notifications.claim_itsm_creation()
RETURNS TABLE (operation_id uuid, tenant_id uuid, incident_id uuid, integration_id uuid, provider text, lease_token uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  WITH expired AS (
    SELECT c.id FROM aiops_notifications.itsm_ticket_creations c
    WHERE c.state = 'PROCESSING' AND c.lease_expires_at_utc <= statement_timestamp()
    ORDER BY c.lease_expires_at_utc, c.id LIMIT 25 FOR UPDATE SKIP LOCKED
  )
  UPDATE aiops_notifications.itsm_ticket_creations c
    SET state = 'NEEDS_RECONCILIATION', last_error = 'LEASE_EXPIRED', lease_token = NULL, lease_expires_at_utc = NULL
    FROM expired WHERE c.id = expired.id;

  RETURN QUERY
  WITH pending AS (
    SELECT c.id, d.provider FROM aiops_notifications.itsm_ticket_creations c
    JOIN aiops_notifications.itsm_integrations d ON d.tenant_id = c.tenant_id AND d.id = c.integration_id AND d.enabled
    JOIN public.tenants t ON t.id = c.tenant_id AND t.status = 'active'
    WHERE c.state IN ('PENDING', 'RETRY_SCHEDULED') AND c.next_attempt_at_utc <= statement_timestamp()
    ORDER BY c.next_attempt_at_utc, c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED
  )
  UPDATE aiops_notifications.itsm_ticket_creations c
    SET state = 'PROCESSING', attempt_count = c.attempt_count + 1,
        lease_token = gen_random_uuid(), lease_expires_at_utc = statement_timestamp() + interval '60 seconds'
    FROM pending WHERE c.id = pending.id
    RETURNING c.id, c.tenant_id, c.incident_id, c.integration_id, pending.provider, c.lease_token;
END $$;

CREATE FUNCTION aiops_notifications.complete_itsm_creation(
  operation_id uuid, expected_lease uuid, result_code text, remote_id text, remote_reference text, retry_after_seconds integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  affected record;
BEGIN
  IF result_code IS NULL OR result_code NOT IN ('SUCCEEDED', 'AUTH', 'PERMISSION', 'NOT_FOUND', 'VALIDATION',
    'RATE_LIMIT', 'REMOTE_ERROR', 'NETWORK', 'NEEDS_RECONCILIATION', 'NOT_SUPPORTED', 'NOT_CONFIGURED')
    OR (result_code = 'SUCCEEDED' AND (remote_id IS NULL OR remote_id !~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$'))
    OR (result_code <> 'SUCCEEDED' AND (remote_id IS NOT NULL OR remote_reference IS NOT NULL))
    OR length(remote_reference) > 128
    OR retry_after_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado ITSM inválido';
  END IF;

  BEGIN
    UPDATE aiops_notifications.itsm_ticket_creations c
      SET state = CASE
          WHEN result_code = 'SUCCEEDED' THEN 'SUCCEEDED'
          WHEN result_code = 'NEEDS_RECONCILIATION' THEN 'NEEDS_RECONCILIATION'
          WHEN result_code IN ('RATE_LIMIT', 'NETWORK', 'REMOTE_ERROR') AND c.attempt_count < 8 THEN 'RETRY_SCHEDULED'
          ELSE 'FAILED'
        END,
        next_attempt_at_utc = statement_timestamp() + make_interval(secs => GREATEST(
          (15 * power(2, c.attempt_count - 1)) * (1 + random() * 0.25), retry_after_seconds
        )),
        last_error = NULLIF(result_code, 'SUCCEEDED'), external_id = remote_id, external_reference = remote_reference,
        confirmed_at_utc = CASE WHEN result_code = 'SUCCEEDED' THEN statement_timestamp() END,
        lease_token = NULL, lease_expires_at_utc = NULL
      WHERE c.id = operation_id AND c.state = 'PROCESSING' AND c.lease_token = expected_lease
        AND c.lease_expires_at_utc > statement_timestamp()
      RETURNING c.tenant_id, c.incident_id, c.state INTO affected;
  EXCEPTION WHEN unique_violation THEN
    UPDATE aiops_notifications.itsm_ticket_creations c
      SET state = 'NEEDS_RECONCILIATION', last_error = 'LINK_CONFLICT', lease_token = NULL, lease_expires_at_utc = NULL
      WHERE c.id = operation_id AND c.state = 'PROCESSING' AND c.lease_token = expected_lease
        AND c.lease_expires_at_utc > statement_timestamp()
      RETURNING c.tenant_id, c.incident_id, c.state INTO affected;
  END;
  IF affected.tenant_id IS NULL THEN RETURN false; END IF;

  INSERT INTO public.audit_logs (tenant_id, action, resource_type, resource_id, details_json)
    VALUES (affected.tenant_id, 'ITSM_TICKET_' || affected.state, 'incident', affected.incident_id::text,
            jsonb_build_object('operation_id', operation_id));
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION aiops_auth.require_itsm_tenant(text, uuid), aiops_auth.list_incident_itsm(text, uuid, uuid),
  aiops_auth.request_itsm_creation(text, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.list_incident_itsm(text, uuid, uuid), aiops_auth.request_itsm_creation(text, uuid, uuid, uuid)
  TO aiops_authenticator;
REVOKE ALL ON FUNCTION aiops_notifications.claim_itsm_creation(),
  aiops_notifications.complete_itsm_creation(uuid, uuid, text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_notifications.claim_itsm_creation(),
  aiops_notifications.complete_itsm_creation(uuid, uuid, text, text, text, integer) TO aiops_itsm_worker;
