-- Against the dedicated Compose database after the release smoke has reviewed the imported incident.
BEGIN;

DO $$
DECLARE
  imported_tenant uuid := '00000000-0000-4000-9000-000000000001';
  imported_incident uuid := '00000000-0000-4000-9000-000000000017';
  other_tenant uuid;
  other_incident uuid;
  acknowledged_id uuid;
  resolved_id uuid;
  reopened_id uuid;
  work record;
  old_lease uuid;
BEGIN
  IF (SELECT array_agg(event_type ORDER BY event_type) FROM aiops_notifications.incident_outbox)
      IS DISTINCT FROM ARRAY['incident.acknowledged', 'incident.resolved']::text[] THEN
    RAISE EXCEPTION 'Somente mudanças de estado devem gerar eventos para entrega';
  END IF;
  SELECT id INTO STRICT acknowledged_id FROM aiops_notifications.incident_outbox WHERE event_type = 'incident.acknowledged';
  SELECT id INTO STRICT resolved_id FROM aiops_notifications.incident_outbox WHERE event_type = 'incident.resolved';

  INSERT INTO public.tenants (name, slug) VALUES ('Outro tenant de teste', 'outbox-fixture') RETURNING id INTO other_tenant;
  INSERT INTO public.incidents (tenant_id, title, opened_at_utc)
    VALUES (other_tenant, 'Incidente de teste', statement_timestamp()) RETURNING id INTO other_incident;

  BEGIN
    INSERT INTO aiops_notifications.incident_outbox (
      tenant_id, incident_id, event_type, previous_status, status, severity, occurred_at_utc
    ) VALUES (imported_tenant, other_incident, 'incident.acknowledged', 'OPEN', 'ACKNOWLEDGED', 'ALTA', statement_timestamp());
    RAISE EXCEPTION 'Vínculo fora do tenant aceito';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE public.incidents SET status = 'OPEN' WHERE id = imported_incident;
    IF NOT EXISTS (SELECT 1 FROM aiops_notifications.incident_outbox WHERE event_type = 'incident.reopened') THEN
      RAISE EXCEPTION 'Evento da reabertura ausente';
    END IF;
    RAISE SQLSTATE 'P1500';
  EXCEPTION WHEN SQLSTATE 'P1500' THEN
    NULL;
  END;

  IF EXISTS (SELECT 1 FROM aiops_notifications.incident_outbox WHERE event_type = 'incident.reopened') THEN
    RAISE EXCEPTION 'Rollback deixou evento órfão';
  END IF;

  -- Ordenação determinística para o teste do claim parcial.
  UPDATE aiops_notifications.incident_outbox SET next_attempt_at_utc =
    statement_timestamp() - CASE id WHEN acknowledged_id THEN interval '2 seconds' ELSE interval '1 second' END;

  IF has_table_privilege('aiops_notification_worker', 'aiops_notifications.incident_outbox', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_schema_privilege('aiops_authenticator', 'aiops_notifications', 'USAGE')
    OR has_schema_privilege('aiops_tenant_reader', 'aiops_notifications', 'USAGE') THEN
    RAISE EXCEPTION 'Acesso direto indevido à fila';
  END IF;

  SET LOCAL ROLE aiops_notification_worker;
  SELECT * INTO STRICT work FROM aiops_notifications.claim_incident_events(1, 30);
  IF work.id <> acknowledged_id OR work.attempt_count <> 1 OR work.tenant_id <> imported_tenant
    OR work.incident_id <> imported_incident OR work.previous_status <> 'OPEN' OR work.status <> 'ACKNOWLEDGED' THEN
    RAISE EXCEPTION 'Claim retornou evento inesperado';
  END IF;
  old_lease := work.lease_token;

  SELECT * INTO STRICT work FROM aiops_notifications.claim_incident_events(1, 30);
  IF work.id <> resolved_id OR EXISTS (SELECT 1 FROM aiops_notifications.claim_incident_events(2, 30)) THEN
    RAISE EXCEPTION 'Claim duplicou processamento ativo';
  END IF;
  IF aiops_notifications.complete_incident_event(resolved_id, old_lease, 'PROCESSED') OR
     NOT aiops_notifications.complete_incident_event(resolved_id, work.lease_token, 'TEMPORARY_FAILURE') THEN
    RAISE EXCEPTION 'Confirmação ignorou o lease da tentativa';
  END IF;
  RESET ROLE;

  IF NOT EXISTS (
    SELECT 1 FROM aiops_notifications.incident_outbox
    WHERE id = resolved_id AND processing_state = 'RETRY_SCHEDULED'
      AND next_attempt_at_utc > statement_timestamp() AND lease_token IS NULL
  ) THEN
    RAISE EXCEPTION 'Falha transitória não agendou retentativa';
  END IF;

  UPDATE aiops_notifications.incident_outbox SET lease_expires_at_utc = statement_timestamp() - interval '1 second'
    WHERE id = acknowledged_id;

  SET LOCAL ROLE aiops_notification_worker;
  IF aiops_notifications.complete_incident_event(acknowledged_id, old_lease, 'PROCESSED') THEN
    RAISE EXCEPTION 'Lease expirado confirmou evento';
  END IF;
  SELECT * INTO STRICT work FROM aiops_notifications.claim_incident_events(1, 30);
  IF work.id <> acknowledged_id OR work.attempt_count <> 2 OR work.lease_token = old_lease THEN
    RAISE EXCEPTION 'Recuperação de claim expirado falhou';
  END IF;
  IF NOT aiops_notifications.complete_incident_event(work.id, work.lease_token, 'PROCESSED') THEN
    RAISE EXCEPTION 'Confirmação do novo lease falhou';
  END IF;
  RESET ROLE;

  UPDATE public.incidents SET status = 'OPEN' WHERE id = imported_incident;
  SELECT id INTO STRICT reopened_id FROM aiops_notifications.incident_outbox WHERE event_type = 'incident.reopened';
  UPDATE aiops_notifications.incident_outbox SET processing_state = 'PROCESSING', attempt_count = 8,
    lease_token = gen_random_uuid(), lease_expires_at_utc = statement_timestamp() - interval '1 second' WHERE id = reopened_id;
  UPDATE aiops_notifications.incident_outbox SET next_attempt_at_utc = statement_timestamp() - interval '1 second'
    WHERE id = resolved_id;
  SET LOCAL ROLE aiops_notification_worker;
  SELECT * INTO STRICT work FROM aiops_notifications.claim_incident_events(1, 30);
  IF work.id <> resolved_id OR NOT aiops_notifications.complete_incident_event(resolved_id, work.lease_token, 'PERMANENT_FAILURE') THEN
    RAISE EXCEPTION 'Falha permanente não encerrada';
  END IF;
  RESET ROLE;

  IF (SELECT count(*) FROM aiops_notifications.incident_outbox WHERE processing_state = 'DEAD_LETTER') <> 2
    OR NOT EXISTS (SELECT 1 FROM aiops_notifications.incident_outbox WHERE id = acknowledged_id AND processing_state = 'PROCESSED') THEN
    RAISE EXCEPTION 'Estado terminal incorreto';
  END IF;
END $$;

ROLLBACK;
