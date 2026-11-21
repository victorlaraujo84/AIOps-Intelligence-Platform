DO $$
BEGIN
  IF (SELECT count(*) FROM aiops_notifications.incident_outbox
      WHERE event_type = 'incident.opened' AND previous_status IS NULL AND status = 'OPEN'
        AND tenant_id = '00000000-0000-4000-9000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'A abertura por ingestão deve enfileirar apenas um evento';
  END IF;
  IF EXISTS (SELECT 1 FROM public.canonical_events WHERE idempotency_key LIKE 'fixture-invalid-%'
      OR idempotency_key = 'fixture-forbidden' OR idempotency_key = 'fixture-stale-tenant') THEN
    RAISE EXCEPTION 'Ingestão inválida gravou dados';
  END IF;
END $$;
