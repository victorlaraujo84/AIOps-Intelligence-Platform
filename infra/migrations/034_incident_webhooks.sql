CREATE TABLE aiops_notifications.webhook_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  origin text NOT NULL CHECK (origin ~ '^https://[a-z0-9][a-z0-9.-]*\.[a-z][a-z0-9-]*$' AND length(origin) <= 255),
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 4 AND
    event_types <@ ARRAY['incident.opened', 'incident.acknowledged', 'incident.resolved', 'incident.reopened']),
  critical_only boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT false,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

ALTER TABLE aiops_notifications.incident_outbox ADD UNIQUE (tenant_id, id);

CREATE TABLE aiops_notifications.webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  channel_revision uuid NOT NULL,
  event_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'PROCESSING', 'DELIVERED', 'RETRY_SCHEDULED', 'DEAD_LETTER', 'DISABLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 8),
  next_attempt_at_utc timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease uuid,
  expires_at_utc timestamptz,
  FOREIGN KEY (tenant_id, channel_id) REFERENCES aiops_notifications.webhook_channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, event_id) REFERENCES aiops_notifications.incident_outbox (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_id, event_id),
  CHECK ((state = 'PROCESSING') = (lease IS NOT NULL AND expires_at_utc IS NOT NULL)),
  CHECK ((lease IS NULL) = (expires_at_utc IS NULL))
);

CREATE TABLE aiops_notifications.webhook_attempts (
  tenant_id uuid NOT NULL,
  delivery_id uuid NOT NULL,
  attempt integer NOT NULL,
  started_at_utc timestamptz NOT NULL,
  finished_at_utc timestamptz,
  outcome text CHECK (outcome IN ('DELIVERED', 'RATE_LIMIT', 'REMOTE_ERROR', 'HTTP_REJECTED', 'TRANSPORT_ERROR',
                                 'NOT_CONFIGURED', 'LEASE_EXPIRED')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  latency_ms integer CHECK (latency_ms >= 0),
  PRIMARY KEY (tenant_id, delivery_id, attempt),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES aiops_notifications.webhook_deliveries (tenant_id, id) ON DELETE CASCADE
);

ALTER TABLE aiops_notifications.webhook_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiops_notifications.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiops_notifications.webhook_attempts ENABLE ROW LEVEL SECURITY;
CREATE INDEX webhook_deliveries_due_idx ON aiops_notifications.webhook_deliveries (next_attempt_at_utc, id)
  WHERE state IN ('PENDING', 'RETRY_SCHEDULED');
CREATE INDEX webhook_deliveries_expired_idx ON aiops_notifications.webhook_deliveries (expires_at_utc, id)
  WHERE state = 'PROCESSING';
CREATE INDEX webhook_deliveries_event_idx ON aiops_notifications.webhook_deliveries (tenant_id, event_id);

CREATE FUNCTION aiops_notifications.enqueue_webhooks()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO aiops_notifications.webhook_deliveries (tenant_id, channel_id, channel_revision, event_id)
    SELECT NEW.tenant_id, c.id, c.revision, NEW.id
    FROM aiops_notifications.webhook_channels c
    WHERE c.tenant_id = NEW.tenant_id AND c.enabled AND NEW.event_type = ANY(c.event_types)
      AND (NOT c.critical_only OR upper(NEW.severity) = 'CRITICA')
    FOR SHARE OF c;
  RETURN NULL;
END $$;

CREATE TRIGGER incidents_enqueue_webhooks AFTER INSERT ON aiops_notifications.incident_outbox
FOR EACH ROW EXECUTE FUNCTION aiops_notifications.enqueue_webhooks();

CREATE FUNCTION aiops_auth.require_webhook_admin(digest text, tenant uuid)
RETURNS TABLE (actor_id uuid, actor_role text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO actor FROM aiops_auth.find_session(digest);
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida'; END IF;
  IF actor.active_tenant_id IS NULL OR actor.active_tenant_id IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Tenant ativo mudou';
  END IF;
  IF actor.role NOT IN ('super_admin', 'tenant_admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito aos administradores';
  END IF;
  RETURN QUERY SELECT actor.id, actor.role;
END $$;

CREATE FUNCTION aiops_auth.list_webhook_channels(digest text, tenant uuid)
RETURNS TABLE (id uuid, name text, origin text, event_types text[], critical_only boolean, enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM aiops_auth.require_webhook_admin(digest, tenant);
  RETURN QUERY SELECT c.id, c.name, c.origin, c.event_types, c.critical_only, c.enabled
    FROM aiops_notifications.webhook_channels c WHERE c.tenant_id = tenant ORDER BY c.name;
END $$;

CREATE FUNCTION aiops_auth.create_webhook_channel(
  digest text, tenant uuid, channel_name text, allowed_origin text, event_filter text[], critical_filter boolean
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  channel uuid;
BEGIN
  PERFORM 1 FROM public.sessions s WHERE s.token_hash = digest FOR UPDATE;
  SELECT * INTO STRICT actor FROM aiops_auth.require_webhook_admin(digest, tenant);
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12016));
  IF (SELECT count(*) FROM aiops_notifications.webhook_channels c WHERE c.tenant_id = tenant) >= 20 THEN
    RAISE EXCEPTION USING ERRCODE = 'P1040', MESSAGE = 'Limite de canais atingido';
  END IF;
  IF channel_name IS NULL OR btrim(channel_name) = '' OR array_position(event_filter, NULL) IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Política de webhook inválida';
  END IF;
  INSERT INTO aiops_notifications.webhook_channels (tenant_id, name, origin, event_types, critical_only)
    VALUES (tenant, btrim(channel_name), allowed_origin, event_filter, critical_filter) RETURNING id INTO channel;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
    VALUES (tenant, actor.actor_id, actor.actor_role, 'WEBHOOK_CHANNEL_CREATED', 'webhook_channel', channel::text);
  RETURN channel;
END $$;

CREATE FUNCTION aiops_auth.set_webhook_channel(digest text, tenant uuid, channel uuid, active boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  previous boolean;
BEGIN
  PERFORM 1 FROM public.sessions s WHERE s.token_hash = digest FOR UPDATE;
  SELECT * INTO STRICT actor FROM aiops_auth.require_webhook_admin(digest, tenant);
  SELECT c.enabled INTO previous FROM aiops_notifications.webhook_channels c
    WHERE c.id = channel AND c.tenant_id = tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1041', MESSAGE = 'Canal indisponível'; END IF;
  IF previous IS NOT DISTINCT FROM active THEN RETURN active; END IF;
  UPDATE aiops_notifications.webhook_channels c SET enabled = active, revision = gen_random_uuid()
    WHERE c.id = channel AND c.tenant_id = tenant;
  UPDATE aiops_notifications.webhook_deliveries d SET state = 'DISABLED'
    WHERE d.tenant_id = tenant AND d.channel_id = channel AND d.state IN ('PENDING', 'RETRY_SCHEDULED');
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
    VALUES (tenant, actor.actor_id, actor.actor_role, CASE WHEN active THEN 'WEBHOOK_CHANNEL_ENABLED' ELSE 'WEBHOOK_CHANNEL_DISABLED' END,
            'webhook_channel', channel::text);
  RETURN active;
END $$;

CREATE FUNCTION aiops_auth.list_webhook_deliveries(digest text, tenant uuid, channel uuid)
RETURNS TABLE (id uuid, event_type text, state text, attempt_count integer, outcome text, http_status integer, finished_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM 1 FROM aiops_auth.require_webhook_admin(digest, tenant);
  IF NOT EXISTS (SELECT 1 FROM aiops_notifications.webhook_channels c WHERE c.id = channel AND c.tenant_id = tenant) THEN
    RAISE EXCEPTION USING ERRCODE = 'P1041', MESSAGE = 'Canal indisponível';
  END IF;
  RETURN QUERY
    SELECT d.id, e.event_type, d.state, d.attempt_count, a.outcome, a.http_status, a.finished_at_utc
    FROM aiops_notifications.webhook_deliveries d
    JOIN aiops_notifications.incident_outbox e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
    LEFT JOIN aiops_notifications.webhook_attempts a
      ON a.tenant_id = d.tenant_id AND a.delivery_id = d.id AND a.attempt = d.attempt_count
    WHERE d.tenant_id = tenant AND d.channel_id = channel
    ORDER BY e.occurred_at_utc DESC, d.id DESC LIMIT 50;
END $$;

CREATE FUNCTION aiops_notifications.claim_webhook()
RETURNS TABLE (delivery_id uuid, tenant_id uuid, channel_id uuid, origin text, lease uuid,
  event_id uuid, incident_id uuid, event_type text, incident_status text, severity text, occurred_at_utc timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job record;
  reserved_at timestamptz := clock_timestamp();
  token uuid := gen_random_uuid();
BEGIN
  WITH expired AS (
    SELECT d.id, c.enabled AND c.revision = d.channel_revision AND t.status = 'active' AS enabled
    FROM aiops_notifications.webhook_deliveries d
    JOIN aiops_notifications.webhook_channels c ON c.tenant_id = d.tenant_id AND c.id = d.channel_id
    JOIN public.tenants t ON t.id = d.tenant_id
    WHERE d.state = 'PROCESSING' AND d.expires_at_utc <= reserved_at
    ORDER BY d.expires_at_utc LIMIT 20 FOR UPDATE OF d SKIP LOCKED
  ), closed AS (
    UPDATE aiops_notifications.webhook_deliveries d SET
      state = CASE WHEN NOT expired.enabled THEN 'DISABLED' WHEN d.attempt_count >= 8 THEN 'DEAD_LETTER' ELSE 'RETRY_SCHEDULED' END,
      next_attempt_at_utc = reserved_at + interval '5 seconds', lease = NULL, expires_at_utc = NULL
    FROM expired WHERE d.id = expired.id RETURNING d.tenant_id, d.id, d.attempt_count
  )
  UPDATE aiops_notifications.webhook_attempts a SET finished_at_utc = reserved_at, outcome = 'LEASE_EXPIRED'
    FROM closed WHERE a.tenant_id = closed.tenant_id AND a.delivery_id = closed.id AND a.attempt = closed.attempt_count;

  SELECT d.id, d.tenant_id, d.channel_id, c.origin, d.event_id, e.incident_id, e.event_type,
         e.status, e.severity, e.occurred_at_utc INTO job
  FROM aiops_notifications.webhook_deliveries d
  JOIN aiops_notifications.webhook_channels c ON c.tenant_id = d.tenant_id AND c.id = d.channel_id
  JOIN aiops_notifications.incident_outbox e ON e.tenant_id = d.tenant_id AND e.id = d.event_id
  JOIN public.tenants t ON t.id = d.tenant_id AND t.status = 'active'
  WHERE d.state IN ('PENDING', 'RETRY_SCHEDULED') AND d.next_attempt_at_utc <= reserved_at
    AND c.enabled AND c.revision = d.channel_revision
    AND NOT EXISTS (
      SELECT 1 FROM aiops_notifications.webhook_deliveries active
      WHERE active.tenant_id = d.tenant_id AND active.channel_id = d.channel_id AND active.state = 'PROCESSING'
    )
  ORDER BY d.next_attempt_at_utc, d.id LIMIT 1 FOR UPDATE OF c, d SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  -- The channel lock also covers a second check after a concurrent claim commits.
  IF EXISTS (SELECT 1 FROM aiops_notifications.webhook_deliveries active
      WHERE active.tenant_id = job.tenant_id AND active.channel_id = job.channel_id AND active.state = 'PROCESSING') THEN
    RETURN;
  END IF;

  UPDATE aiops_notifications.webhook_deliveries d SET state = 'PROCESSING', attempt_count = d.attempt_count + 1,
    lease = token, expires_at_utc = reserved_at + interval '30 seconds' WHERE d.id = job.id;
  INSERT INTO aiops_notifications.webhook_attempts (tenant_id, delivery_id, attempt, started_at_utc)
    SELECT d.tenant_id, d.id, d.attempt_count, reserved_at FROM aiops_notifications.webhook_deliveries d WHERE d.id = job.id;
  RETURN QUERY SELECT job.id, job.tenant_id, job.channel_id, job.origin, token, job.event_id, job.incident_id,
    job.event_type, job.status, job.severity, job.occurred_at_utc;
END $$;

CREATE FUNCTION aiops_notifications.complete_webhook(
  tenant uuid, delivery uuid, token uuid, result text, response_status integer, retry_after integer
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  finished timestamptz := clock_timestamp();
  job record;
BEGIN
  IF result IS NULL OR result NOT IN ('DELIVERED', 'RATE_LIMIT', 'REMOTE_ERROR', 'HTTP_REJECTED', 'TRANSPORT_ERROR', 'NOT_CONFIGURED')
     OR retry_after NOT BETWEEN 1 AND 86400 OR response_status NOT BETWEEN 100 AND 599
     OR (result = 'DELIVERED' AND (response_status IS NULL OR response_status NOT BETWEEN 200 AND 299)) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado de webhook inválido';
  END IF;
  UPDATE aiops_notifications.webhook_deliveries d SET
    state = CASE
      WHEN result = 'DELIVERED' THEN 'DELIVERED'
      WHEN NOT c.enabled OR c.revision <> d.channel_revision THEN 'DISABLED'
      WHEN result IN ('RATE_LIMIT', 'REMOTE_ERROR', 'TRANSPORT_ERROR') AND d.attempt_count < 8 THEN 'RETRY_SCHEDULED'
      ELSE 'DEAD_LETTER' END,
    next_attempt_at_utc = finished + make_interval(secs => GREATEST(5 * power(2, d.attempt_count - 1) * (1 + random() * 0.25), retry_after)),
    lease = NULL, expires_at_utc = NULL
  FROM aiops_notifications.webhook_channels c
  WHERE c.tenant_id = d.tenant_id AND c.id = d.channel_id AND d.tenant_id = tenant AND d.id = delivery
    AND d.state = 'PROCESSING' AND d.lease = token AND d.expires_at_utc > finished
  RETURNING d.attempt_count INTO job;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE aiops_notifications.webhook_attempts a SET outcome = result, http_status = response_status, finished_at_utc = finished,
    latency_ms = round(extract(epoch FROM finished - a.started_at_utc) * 1000)::integer
    WHERE a.tenant_id = tenant AND a.delivery_id = delivery AND a.attempt = job.attempt_count;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION aiops_notifications.enqueue_webhooks(), aiops_notifications.claim_webhook(),
  aiops_notifications.complete_webhook(uuid, uuid, uuid, text, integer, integer),
  aiops_auth.require_webhook_admin(text, uuid), aiops_auth.list_webhook_channels(text, uuid),
  aiops_auth.create_webhook_channel(text, uuid, text, text, text[], boolean),
  aiops_auth.set_webhook_channel(text, uuid, uuid, boolean), aiops_auth.list_webhook_deliveries(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_notifications.claim_webhook(),
  aiops_notifications.complete_webhook(uuid, uuid, uuid, text, integer, integer) TO aiops_notification_worker;
GRANT EXECUTE ON FUNCTION aiops_auth.list_webhook_channels(text, uuid),
  aiops_auth.create_webhook_channel(text, uuid, text, text, text[], boolean),
  aiops_auth.set_webhook_channel(text, uuid, uuid, boolean), aiops_auth.list_webhook_deliveries(text, uuid, uuid)
  TO aiops_authenticator;
