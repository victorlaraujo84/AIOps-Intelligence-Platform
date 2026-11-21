CREATE SCHEMA aiops_notifications;
REVOKE ALL ON SCHEMA aiops_notifications FROM PUBLIC;

DO $$
BEGIN
  BEGIN
    CREATE ROLE aiops_notification_worker NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_notification_worker'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_notification_worker', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Papel aiops_notification_worker com privilégios incompatíveis';
  END IF;
END $$;

CREATE TABLE aiops_notifications.incident_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  incident_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('incident.acknowledged', 'incident.resolved', 'incident.reopened')),
  previous_status text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  severity text NOT NULL,
  occurred_at_utc timestamptz NOT NULL,
  processing_state text NOT NULL DEFAULT 'PENDING'
    CHECK (processing_state IN ('PENDING', 'PROCESSING', 'PROCESSED', 'RETRY_SCHEDULED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at_utc timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_token uuid,
  lease_expires_at_utc timestamptz,
  last_failure text CHECK (last_failure IN ('LEASE_EXPIRED', 'TEMPORARY_FAILURE', 'PERMANENT_FAILURE')),
  CONSTRAINT incident_outbox_incident_fkey FOREIGN KEY (tenant_id, incident_id)
    REFERENCES public.incidents (tenant_id, id) ON DELETE CASCADE,
  CHECK (
    (processing_state = 'PROCESSING' AND lease_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
    OR (processing_state <> 'PROCESSING' AND lease_token IS NULL AND lease_expires_at_utc IS NULL)
  )
);

ALTER TABLE aiops_notifications.incident_outbox ENABLE ROW LEVEL SECURITY;
CREATE INDEX incident_outbox_incident_idx ON aiops_notifications.incident_outbox (tenant_id, incident_id);
CREATE INDEX incident_outbox_ready_idx ON aiops_notifications.incident_outbox (next_attempt_at_utc, id)
  WHERE processing_state IN ('PENDING', 'RETRY_SCHEDULED');
CREATE INDEX incident_outbox_expired_idx ON aiops_notifications.incident_outbox (lease_expires_at_utc, id)
  WHERE processing_state = 'PROCESSING';

CREATE FUNCTION aiops_notifications.queue_incident_transition()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO aiops_notifications.incident_outbox (
    tenant_id, incident_id, event_type, previous_status, status, severity, occurred_at_utc
  ) VALUES (
    NEW.tenant_id, NEW.id,
    CASE NEW.status WHEN 'ACKNOWLEDGED' THEN 'incident.acknowledged'
                    WHEN 'RESOLVED' THEN 'incident.resolved'
                    WHEN 'OPEN' THEN 'incident.reopened' END,
    OLD.status, NEW.status, NEW.severity, COALESCE(NEW.human_reviewed_at_utc, statement_timestamp())
  );
  RETURN NULL;
END $$;

-- Importing a snapshot uses INSERT and never produces outgoing events.
CREATE TRIGGER incidents_queue_transition
AFTER UPDATE OF status ON public.incidents
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND NEW.status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED'))
EXECUTE FUNCTION aiops_notifications.queue_incident_transition();

CREATE FUNCTION aiops_notifications.claim_incident_events(batch_size integer, lease_seconds integer)
RETURNS TABLE (
  id uuid, tenant_id uuid, incident_id uuid, event_type text, previous_status text, status text,
  severity text, occurred_at_utc timestamptz, attempt_count integer, lease_token uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  claimed_at timestamptz := statement_timestamp();
BEGIN
  IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 50
     OR lease_seconds IS NULL OR lease_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Lote ou lease inválido';
  END IF;

  WITH exhausted AS (
    SELECT q.id FROM aiops_notifications.incident_outbox q
    WHERE q.processing_state = 'PROCESSING' AND q.attempt_count = 8 AND q.lease_expires_at_utc <= claimed_at
    ORDER BY q.lease_expires_at_utc, q.id LIMIT batch_size FOR UPDATE SKIP LOCKED
  )
  UPDATE aiops_notifications.incident_outbox q
  SET processing_state = 'DEAD_LETTER', lease_token = NULL, lease_expires_at_utc = NULL, last_failure = 'LEASE_EXPIRED'
  FROM exhausted WHERE q.id = exhausted.id;

  RETURN QUERY
  WITH ready AS (
    SELECT q.id FROM aiops_notifications.incident_outbox q
    WHERE ((q.processing_state IN ('PENDING', 'RETRY_SCHEDULED') AND q.next_attempt_at_utc <= claimed_at)
           OR (q.processing_state = 'PROCESSING' AND q.lease_expires_at_utc <= claimed_at))
      AND q.attempt_count < 8
    ORDER BY q.next_attempt_at_utc, q.id LIMIT batch_size FOR UPDATE SKIP LOCKED
  )
  UPDATE aiops_notifications.incident_outbox q
  SET processing_state = 'PROCESSING', attempt_count = q.attempt_count + 1,
      lease_token = gen_random_uuid(), lease_expires_at_utc = claimed_at + make_interval(secs => lease_seconds),
      last_failure = CASE WHEN q.processing_state = 'PROCESSING' THEN 'LEASE_EXPIRED' ELSE q.last_failure END
  FROM ready WHERE q.id = ready.id
  RETURNING q.id, q.tenant_id, q.incident_id, q.event_type, q.previous_status, q.status,
            q.severity, q.occurred_at_utc, q.attempt_count, q.lease_token;
END $$;

CREATE FUNCTION aiops_notifications.complete_incident_event(event_id uuid, expected_lease uuid, outcome text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF outcome IS NULL OR outcome NOT IN ('PROCESSED', 'TEMPORARY_FAILURE', 'PERMANENT_FAILURE') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado inválido';
  END IF;

  UPDATE aiops_notifications.incident_outbox q
  SET processing_state = CASE
        WHEN outcome = 'PROCESSED' THEN 'PROCESSED'
        WHEN outcome = 'PERMANENT_FAILURE' OR q.attempt_count >= 8 THEN 'DEAD_LETTER'
        ELSE 'RETRY_SCHEDULED'
      END,
      next_attempt_at_utc = CASE WHEN outcome = 'TEMPORARY_FAILURE' AND q.attempt_count < 8 THEN
        statement_timestamp() + make_interval(secs => (5 * power(2, q.attempt_count - 1)) * (1 + random() * 0.25))
        ELSE q.next_attempt_at_utc
      END,
      last_failure = NULLIF(outcome, 'PROCESSED'), lease_token = NULL, lease_expires_at_utc = NULL
  WHERE q.id = event_id AND q.processing_state = 'PROCESSING'
    AND q.lease_token = expected_lease AND q.lease_expires_at_utc > statement_timestamp();
  RETURN FOUND;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aiops_notifications FROM PUBLIC;
GRANT USAGE ON SCHEMA aiops_notifications TO aiops_notification_worker;
GRANT EXECUTE ON FUNCTION
  aiops_notifications.claim_incident_events(integer, integer),
  aiops_notifications.complete_incident_event(uuid, uuid, text)
TO aiops_notification_worker;
