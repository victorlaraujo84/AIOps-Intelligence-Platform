-- Explicit test fixtures. All rows below are rolled back.
BEGIN;
DO $$
DECLARE
  tenant uuid := '00000000-0000-4000-9000-000000000001';
  incident uuid := '00000000-0000-4000-9000-000000000017';
  fixture_admin uuid := '00000000-0000-4000-9000-000000000011';
  viewer uuid;
  other uuid;
  other_incident uuid;
  channel uuid;
  event uuid;
  job record;
  first_token uuid;
BEGIN
  SELECT id INTO STRICT viewer FROM public.users WHERE email = 'release-viewer@example.invalid';
  INSERT INTO public.tenants (name, slug) VALUES ('Outro tenant de webhook', 'other-webhook-fixture') RETURNING id INTO other;
  INSERT INTO public.incidents (tenant_id, title, opened_at_utc) VALUES (other, 'Fixture', now()) RETURNING id INTO other_incident;
  INSERT INTO public.sessions (user_id, user_role, admin_tenant_id, token_hash, expires_at_utc)
    VALUES (fixture_admin, 'super_admin', tenant, repeat('e', 64), now() + interval '1 hour');
  INSERT INTO public.sessions (user_id, user_role, tenant_id, token_hash, expires_at_utc)
    VALUES (viewer, 'tenant_viewer', tenant, repeat('d', 64), now() + interval '1 hour');

  SET LOCAL ROLE aiops_authenticator;
  BEGIN
    PERFORM aiops_auth.create_webhook_channel(repeat('d', 64), tenant, 'Bloqueado', 'https://example.invalid',
      ARRAY['incident.opened'], true);
    RAISE EXCEPTION 'Usuário somente leitura criou canal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT aiops_auth.create_webhook_channel(repeat('e', 64), tenant, 'Canal de teste', 'https://example.invalid',
      ARRAY['incident.opened'], true) INTO channel;
  RESET ROLE;

  INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
    VALUES (tenant, incident, 'incident.opened', 'OPEN', 'CRITICA', now());
  IF EXISTS (SELECT 1 FROM aiops_notifications.webhook_deliveries WHERE channel_id = channel) THEN
    RAISE EXCEPTION 'Canal criado com envio ativo';
  END IF;

  SET LOCAL ROLE aiops_authenticator;
  PERFORM aiops_auth.set_webhook_channel(repeat('e', 64), tenant, channel, true);
  BEGIN
    PERFORM aiops_auth.list_webhook_deliveries(repeat('e', 64), other, channel);
    RAISE EXCEPTION 'Tenant ativo ignorado';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;
  RESET ROLE;

  INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
    VALUES (other, other_incident, 'incident.opened', 'OPEN', 'CRITICA', now()),
           (tenant, incident, 'incident.opened', 'OPEN', 'ALTA', now()),
           (tenant, incident, 'incident.resolved', 'RESOLVED', 'CRITICA', now());
  BEGIN
    INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
      VALUES (tenant, incident, 'incident.opened', 'OPEN', 'CRITICA', now());
    IF (SELECT count(*) FROM aiops_notifications.webhook_deliveries WHERE channel_id = channel) <> 1 THEN
      RAISE EXCEPTION 'Fan-out deveria acompanhar a transação';
    END IF;
    RAISE SQLSTATE 'P1400';
  EXCEPTION WHEN SQLSTATE 'P1400' THEN NULL;
  END;
  INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
    VALUES (tenant, incident, 'incident.opened', 'OPEN', 'CRITICA', now()) RETURNING id INTO event;
  IF (SELECT count(*) FROM aiops_notifications.webhook_deliveries WHERE channel_id = channel) <> 1 THEN
    RAISE EXCEPTION 'Fan-out incidiu fora da política';
  END IF;

  SET LOCAL ROLE aiops_notification_worker;
  SELECT * INTO STRICT job FROM aiops_notifications.claim_webhook();
  IF job.event_id <> event OR job.tenant_id <> tenant OR EXISTS (SELECT 1 FROM aiops_notifications.claim_webhook()) THEN
    RAISE EXCEPTION 'Reserva duplicada ou fora do escopo';
  END IF;
  first_token := job.lease;
  IF aiops_notifications.complete_webhook(tenant, job.delivery_id, gen_random_uuid(), 'DELIVERED', 204, NULL) THEN
    RAISE EXCEPTION 'Lease inválido confirmou entrega';
  END IF;
  IF NOT aiops_notifications.complete_webhook(tenant, job.delivery_id, job.lease, 'RATE_LIMIT', 429, 240) THEN
    RAISE EXCEPTION 'Retentativa rejeitada';
  END IF;
  RESET ROLE;

  UPDATE aiops_notifications.webhook_deliveries SET next_attempt_at_utc = now() - interval '1 minute'
    WHERE id = job.delivery_id AND state = 'RETRY_SCHEDULED' AND next_attempt_at_utc >= statement_timestamp() + interval '4 minutes';
  IF NOT FOUND THEN RAISE EXCEPTION 'Retry-After ignorado'; END IF;
  SET LOCAL ROLE aiops_notification_worker;
  SELECT * INTO STRICT job FROM aiops_notifications.claim_webhook();
  IF job.lease = first_token THEN RAISE EXCEPTION 'Lease reutilizado'; END IF;
  IF NOT aiops_notifications.complete_webhook(tenant, job.delivery_id, job.lease, 'DELIVERED', 204, NULL) THEN
    RAISE EXCEPTION 'Entrega não confirmada';
  END IF;
  RESET ROLE;
  IF (SELECT count(*) FROM aiops_notifications.webhook_attempts WHERE delivery_id = job.delivery_id) <> 2 THEN
    RAISE EXCEPTION 'Histórico de tentativas incompleto';
  END IF;
  INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
    VALUES (tenant, incident, 'incident.opened', 'OPEN', 'CRITICA', now());
  SET LOCAL ROLE aiops_notification_worker;
  SELECT * INTO STRICT job FROM aiops_notifications.claim_webhook();
  RESET ROLE;
  UPDATE aiops_notifications.webhook_deliveries SET attempt_count = 8, expires_at_utc = now() - interval '1 second'
    WHERE id = job.delivery_id;
  UPDATE aiops_notifications.webhook_attempts SET attempt = 8 WHERE delivery_id = job.delivery_id;
  SET LOCAL ROLE aiops_notification_worker;
  IF EXISTS (SELECT 1 FROM aiops_notifications.claim_webhook()) THEN RAISE EXCEPTION 'Limite de tentativas ignorado'; END IF;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM aiops_notifications.webhook_deliveries WHERE id = job.delivery_id AND state = 'DEAD_LETTER') THEN
    RAISE EXCEPTION 'Dead letter ausente';
  END IF;

  INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
    VALUES (tenant, incident, 'incident.opened', 'OPEN', 'CRITICA', now()) RETURNING id INTO event;
  SET LOCAL ROLE aiops_authenticator;
  PERFORM aiops_auth.set_webhook_channel(repeat('e', 64), tenant, channel, false);
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM aiops_notifications.webhook_deliveries WHERE event_id = event AND state = 'DISABLED') THEN
    RAISE EXCEPTION 'Desativação manteve entrega pendente';
  END IF;
END $$;
ROLLBACK;
