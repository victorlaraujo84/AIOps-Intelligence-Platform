-- Dedicated release fixture only. All records created here are rolled back.
BEGIN;
DO $$
DECLARE
  tenant uuid := '00000000-0000-4000-9000-000000000001';
  incident uuid := '00000000-0000-4000-9000-000000000017';
  another uuid;
  viewer uuid;
  enabled_id uuid;
  other_id uuid;
  ambiguous_id uuid;
  operation record;
  claimed record;
  stale_lease uuid;
BEGIN
  INSERT INTO public.tenants (name, slug) VALUES ('Tenant ITSM fixture', 'itsm-fixture') RETURNING id INTO another;
  SELECT id INTO STRICT viewer FROM public.users WHERE email = 'release-viewer@example.invalid';
  INSERT INTO public.sessions (user_id, user_role, admin_tenant_id, token_hash, expires_at_utc)
    VALUES ('00000000-0000-4000-9000-000000000011', 'super_admin', tenant, repeat('e', 64), now() + interval '1 hour');
  INSERT INTO public.sessions (user_id, user_role, tenant_id, token_hash, expires_at_utc)
    VALUES (viewer, 'tenant_viewer', tenant, repeat('d', 64), now() + interval '1 hour');
  INSERT INTO aiops_notifications.itsm_integrations (tenant_id, name, provider, enabled, create_ticket_verified_at)
    VALUES (tenant, 'Jira fixture', 'jira-service-management', true, now()) RETURNING id INTO enabled_id;
  INSERT INTO aiops_notifications.itsm_integrations (tenant_id, name, provider, enabled, create_ticket_verified_at)
    VALUES (tenant, 'GLPI fixture', 'glpi', true, now()) RETURNING id INTO ambiguous_id;
  INSERT INTO aiops_notifications.itsm_integrations (tenant_id, name, provider, enabled, create_ticket_verified_at)
    VALUES (another, 'TOPdesk fixture', 'topdesk', true, now()) RETURNING id INTO other_id;

  SET LOCAL ROLE aiops_authenticator;
  IF (SELECT count(*) FROM aiops_auth.list_incident_itsm(repeat('e', 64), tenant, incident)) <> 2 THEN
    RAISE EXCEPTION 'Listagem ITSM mostrou integrações fora do tenant';
  END IF;
  BEGIN
    PERFORM aiops_auth.request_itsm_creation(repeat('d', 64), tenant, incident, enabled_id);
    RAISE EXCEPTION 'A conta de leitura conseguiu solicitar chamado';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM aiops_auth.request_itsm_creation(repeat('e', 64), another, incident, other_id);
    RAISE EXCEPTION 'A seleção do tenant ativo foi ignorada';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  BEGIN
    PERFORM aiops_auth.request_itsm_creation(repeat('e', 64), tenant, incident, other_id);
    RAISE EXCEPTION 'A integração de outro tenant foi aceita';
  EXCEPTION WHEN SQLSTATE 'P1020' THEN NULL;
  END;
  SELECT * INTO STRICT operation FROM aiops_auth.request_itsm_creation(repeat('e', 64), tenant, incident, enabled_id);
  IF operation.state <> 'PENDING' OR
      (SELECT operation_id FROM aiops_auth.request_itsm_creation(repeat('e', 64), tenant, incident, enabled_id)) <> operation.operation_id THEN
    RAISE EXCEPTION 'Pedido ITSM duplicado';
  END IF;
  RESET ROLE;

  SET LOCAL ROLE aiops_itsm_worker;
  SELECT * INTO STRICT claimed FROM aiops_notifications.claim_itsm_creation();
  IF claimed.operation_id <> operation.operation_id OR claimed.provider <> 'jira-service-management' THEN
    RAISE EXCEPTION 'Operação reservada incorretamente';
  END IF;
  stale_lease := claimed.lease_token;
  IF NOT aiops_notifications.complete_itsm_creation(claimed.operation_id, stale_lease, 'RATE_LIMIT', NULL, NULL, 240) THEN
    RAISE EXCEPTION 'O 429 deveria agendar retentativa';
  END IF;
  RESET ROLE;
  UPDATE aiops_notifications.itsm_ticket_creations
    SET next_attempt_at_utc = statement_timestamp() - interval '1 second'
    WHERE id = operation.operation_id AND state = 'RETRY_SCHEDULED'
      AND next_attempt_at_utc >= statement_timestamp() + interval '4 minutes';
  IF NOT FOUND THEN RAISE EXCEPTION 'Retentativa ITSM ausente'; END IF;

  SET LOCAL ROLE aiops_itsm_worker;
  SELECT * INTO STRICT claimed FROM aiops_notifications.claim_itsm_creation();
  IF aiops_notifications.complete_itsm_creation(claimed.operation_id, stale_lease, 'SUCCEEDED', 'AIOPS-42', NULL) THEN
    RAISE EXCEPTION 'Lease anterior alterou vínculo ITSM';
  END IF;
  IF NOT aiops_notifications.complete_itsm_creation(claimed.operation_id, claimed.lease_token, 'SUCCEEDED', 'AIOPS-42', NULL) THEN
    RAISE EXCEPTION 'Vínculo ITSM de fixture não confirmado';
  END IF;
  RESET ROLE;

  SET LOCAL ROLE aiops_authenticator;
  IF NOT EXISTS (SELECT 1 FROM aiops_auth.list_incident_itsm(repeat('d', 64), tenant, incident)
       WHERE state = 'SUCCEEDED' AND external_id = 'AIOPS-42') THEN
    RAISE EXCEPTION 'Vínculo ITSM persistido indisponível para consulta';
  END IF;
  SELECT * INTO STRICT operation FROM aiops_auth.request_itsm_creation(repeat('e', 64), tenant, incident, ambiguous_id);
  RESET ROLE;

  SET LOCAL ROLE aiops_itsm_worker;
  SELECT * INTO STRICT claimed FROM aiops_notifications.claim_itsm_creation();
  RESET ROLE;
  UPDATE aiops_notifications.itsm_ticket_creations SET lease_expires_at_utc = statement_timestamp() - interval '1 second'
    WHERE id = operation.operation_id;
  SET LOCAL ROLE aiops_itsm_worker;
  IF EXISTS (SELECT 1 FROM aiops_notifications.claim_itsm_creation()) THEN
    RAISE EXCEPTION 'Criação de resultado incerto foi reenviada';
  END IF;
  RESET ROLE;
  IF NOT EXISTS (
    SELECT 1 FROM aiops_notifications.itsm_ticket_creations
    WHERE id = operation.operation_id AND state = 'NEEDS_RECONCILIATION' AND last_error = 'LEASE_EXPIRED'
  ) OR (SELECT count(*) FROM public.audit_logs WHERE action = 'ITSM_TICKET_REQUESTED' AND tenant_id = tenant) <> 2 THEN
    RAISE EXCEPTION 'Estado de reconciliação ou trilha de auditoria inválidos';
  END IF;
END $$;
ROLLBACK;
