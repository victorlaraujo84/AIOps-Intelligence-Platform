ALTER TABLE aiops_notifications.incident_outbox
  DROP CONSTRAINT incident_outbox_event_type_check,
  ADD CHECK (event_type IN ('incident.opened', 'incident.acknowledged', 'incident.resolved', 'incident.reopened')),
  ALTER COLUMN previous_status DROP NOT NULL;

CREATE FUNCTION aiops_auth.require_ingest_actor(digest text, expected_tenant uuid)
RETURNS TABLE (actor_id uuid, actor_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
BEGIN
  PERFORM 1 FROM public.sessions s WHERE s.token_hash = digest FOR UPDATE;
  SELECT * INTO actor FROM aiops_auth.find_session(digest);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida';
  END IF;
  IF actor.role NOT IN ('super_admin', 'tenant_admin', 'tenant_operator') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito aos operadores';
  END IF;
  IF actor.active_tenant_id IS NULL OR actor.active_tenant_id IS DISTINCT FROM expected_tenant THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Tenant ativo mudou';
  END IF;
  RETURN QUERY SELECT actor.id, actor.role;
END $$;

CREATE FUNCTION aiops_auth.create_event_connector(digest text, tenant uuid, connector_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  connector uuid;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  IF actor.actor_role NOT IN ('super_admin', 'tenant_admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito aos administradores';
  END IF;
  IF connector_name IS NULL OR length(btrim(connector_name)) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Nome de conector inválido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  SELECT c.id INTO connector FROM public.connectors c
    WHERE c.tenant_id = tenant AND c.connector_type = 'webhook_csv' AND c.name = btrim(connector_name)
    ORDER BY c.created_at_utc, c.id LIMIT 1;
  IF connector IS NULL THEN
    INSERT INTO public.connectors (tenant_id, connector_type, name)
      VALUES (tenant, 'webhook_csv', btrim(connector_name)) RETURNING id INTO connector;
    INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
      VALUES (tenant, actor.actor_id, actor.actor_role, 'CONNECTOR_CREATED', 'connector', connector::text);
  END IF;
  RETURN connector;
END $$;

CREATE FUNCTION aiops_auth.correlate_ingested_event(tenant uuid, event uuid, asset_domain text)
RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  received record;
  previous record;
  related_assets uuid[];
  affected_services integer;
  inferred text;
  evidence jsonb;
  next_severity text;
  incident uuid;
  newly_opened boolean;
BEGIN
  SELECT * INTO STRICT received FROM public.canonical_events e WHERE e.tenant_id = tenant AND e.id = event;
  WITH RECURSIVE
    upstream(id) AS (
      SELECT received.asset_id WHERE received.asset_id IS NOT NULL
      UNION SELECT e.source_asset_id FROM public.topology_edges e JOIN upstream t ON e.target_asset_id = t.id
        WHERE e.tenant_id = tenant
    ),
    downstream(id) AS (
      SELECT received.asset_id WHERE received.asset_id IS NOT NULL
      UNION SELECT e.target_asset_id FROM public.topology_edges e JOIN downstream t ON e.source_asset_id = t.id
        WHERE e.tenant_id = tenant
    ),
    connected AS (SELECT id FROM upstream UNION SELECT id FROM downstream),
    impact(id) AS (
      SELECT d.service_id FROM public.service_dependencies d JOIN connected a ON a.id = d.asset_id
        WHERE d.tenant_id = tenant
      UNION SELECT d.service_id FROM public.service_dependencies d JOIN impact i ON i.id = d.upstream_service_id
        WHERE d.tenant_id = tenant
    )
  SELECT COALESCE((SELECT array_agg(id) FROM connected), '{}'::uuid[]), (SELECT count(*) FROM impact)
    INTO related_assets, affected_services;
  inferred := CASE
    WHEN received.event_type ~* 'power|ups|generator' OR lower(asset_domain) = 'energia' THEN 'eletrica'
    WHEN received.event_type ~* 'weather|rain|wind' OR lower(asset_domain) = 'ambiente' THEN 'climatica_direta'
    WHEN received.event_type ~* 'app|http|db|otlp|cpu|memory' OR lower(asset_domain) = 'ti' THEN 'ti_aplicacao'
    WHEN received.event_type ~* 'mqtt|sensor|telemetry_iot' OR lower(asset_domain) = 'iot' THEN 'iot_sensor'
    WHEN received.event_type ~* 'network|link|icmp|snmp' OR received.source ~* 'zabbix|prtg'
      OR lower(asset_domain) = 'rede' THEN 'telecom_outros'
    ELSE 'desconhecida'
  END;
  evidence := jsonb_build_array(jsonb_build_object(
    'type', 'event_correlation', 'event_id', event, 'hypothesis', inferred,
    'observed_at_utc', received.observed_at_utc, 'potentially_impacted_services', affected_services
  ));
  SELECT i.id, i.rca_category, i.human_reviewed_at_utc, i.impacted_services_count, i.severity
    INTO previous FROM public.incidents i
    WHERE i.tenant_id = tenant AND i.status <> 'RESOLVED'
      AND (i.root_asset_id = ANY (related_assets) OR i.root_site_id = received.site_id)
    ORDER BY (i.root_asset_id = ANY (related_assets)) DESC NULLS LAST, i.opened_at_utc DESC, i.id DESC
    LIMIT 1 FOR UPDATE;
  newly_opened := NOT FOUND;
  next_severity := CASE WHEN affected_services >= 2 OR upper(received.status) IN ('CRITICAL', 'OUTAGE') THEN 'CRITICA' ELSE 'ALTA' END;
  IF newly_opened THEN
    INSERT INTO public.incidents (
      tenant_id, root_site_id, root_asset_id, title, severity, opened_at_utc,
      impacted_services_count, rca_category, rca_evidence_json, rule_version
    ) VALUES (
      tenant, received.site_id, received.asset_id, received.event_type || ' — ' || received.status || ' (' || received.source || ')',
      next_severity, received.event_time_utc, affected_services, inferred, evidence, 'rca-rules-v2.0'
    ) RETURNING id INTO incident;
    INSERT INTO aiops_notifications.incident_outbox (tenant_id, incident_id, event_type, status, severity, occurred_at_utc)
      VALUES (tenant, incident, 'incident.opened', 'OPEN', next_severity, clock_timestamp());
  ELSE
    incident := previous.id;
    UPDATE public.incidents i SET
      severity = CASE WHEN next_severity = 'CRITICA' THEN 'CRITICA' ELSE previous.severity END,
      impacted_services_count = GREATEST(previous.impacted_services_count, affected_services),
      rca_category = CASE
        WHEN previous.human_reviewed_at_utc IS NOT NULL OR inferred = 'desconhecida' THEN previous.rca_category
        WHEN previous.rca_category = 'desconhecida' THEN inferred
        WHEN previous.rca_category <> inferred THEN 'composta'
        ELSE previous.rca_category END,
      rca_evidence_json = (
        SELECT jsonb_agg(entry ORDER BY ord)
        FROM (
          SELECT entry, ord, count(*) FILTER (WHERE entry->>'type' = 'event_correlation')
            OVER (ORDER BY ord DESC) AS recent_automatic
          FROM jsonb_array_elements(i.rca_evidence_json || evidence) WITH ORDINALITY AS ev(entry, ord)
        ) entries
        WHERE entry->>'type' IS DISTINCT FROM 'event_correlation' OR recent_automatic <= 25
      )
    WHERE i.tenant_id = tenant AND i.id = incident;
  END IF;
  INSERT INTO public.incident_events (tenant_id, incident_id, event_id, role_in_incident)
    VALUES (tenant, incident, event, CASE WHEN newly_opened THEN 'root_candidate' ELSE 'correlated' END);
  RETURN newly_opened;
END $$;

CREATE FUNCTION aiops_auth.ingest_connector_events(digest text, tenant uuid, connector uuid, events jsonb)
RETURNS TABLE (run_id uuid, ingested integer, deduplicated integer, created_incidents integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  item record;
  asset record;
  site record;
  site_id uuid;
  event_id uuid;
  run_start timestamptz := clock_timestamp();
  run_end timestamptz;
  quality text;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  IF jsonb_typeof(events) IS DISTINCT FROM 'array' OR jsonb_array_length(events) NOT BETWEEN 1 AND 100
     OR octet_length(events::text) > 524288 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Lote inválido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  PERFORM 1 FROM public.connectors c WHERE c.tenant_id = tenant AND c.id = connector AND c.status <> 'DISABLED' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Conector indisponível'; END IF;

  ingested := 0;
  deduplicated := 0;
  created_incidents := 0;
  FOR item IN SELECT * FROM jsonb_to_recordset(events) AS e(
    idempotency_key text, asset_id uuid, site_id uuid, event_time_utc timestamptz, observed_at_utc timestamptz,
    forecast_issued_at_utc timestamptz, source text, event_type text, status text,
    lat double precision, lon double precision, quality_flag text, payload jsonb
  ) LOOP
    IF length(btrim(COALESCE(item.idempotency_key, ''))) NOT BETWEEN 1 AND 200
      OR length(btrim(COALESCE(item.source, ''))) NOT BETWEEN 1 AND 120
      OR length(btrim(COALESCE(item.event_type, ''))) NOT BETWEEN 1 AND 120
      OR length(btrim(COALESCE(item.status, ''))) NOT BETWEEN 1 AND 40
      OR item.event_time_utc IS NULL OR item.observed_at_utc IS NULL
      OR (item.event_type ILIKE '%forecast%' AND item.forecast_issued_at_utc IS NULL)
      OR item.lat NOT BETWEEN -90 AND 90 OR item.lon NOT BETWEEN -180 AND 180
      OR COALESCE(item.quality_flag, 'VALID') NOT IN ('VALID', 'STALE', 'SUSPECT', 'UNVERIFIED_COORDS')
      OR (item.payload IS NOT NULL AND jsonb_typeof(item.payload) <> 'object') THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Evento canônico inválido';
    END IF;
    SELECT a.site_id, a.domain INTO asset FROM public.assets a WHERE a.tenant_id = tenant AND a.id = item.asset_id;
    IF item.asset_id IS NOT NULL AND NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'Ativo indisponível neste tenant';
    END IF;
    IF asset.site_id IS NOT NULL AND item.site_id IS NOT NULL AND asset.site_id <> item.site_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'O site difere do cadastro do ativo';
    END IF;
    site_id := COALESCE(asset.site_id, item.site_id);
    SELECT s.latitude, s.longitude, s.coord_verified INTO site FROM public.sites s WHERE s.tenant_id = tenant AND s.id = site_id;
    IF site_id IS NOT NULL AND NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'Site indisponível neste tenant';
    END IF;
    quality := COALESCE(item.quality_flag, 'VALID');
    IF site_id IS NOT NULL AND NOT site.coord_verified AND quality = 'VALID' THEN quality := 'UNVERIFIED_COORDS'; END IF;
    INSERT INTO public.canonical_events (
      tenant_id, connector_id, idempotency_key, asset_id, site_id, event_time_utc, observed_at_utc,
      forecast_issued_at_utc, source, event_type, status, quality_flag, lat, lon, payload_json
    ) VALUES (
      tenant, connector, btrim(item.idempotency_key), item.asset_id, site_id, item.event_time_utc, item.observed_at_utc,
      item.forecast_issued_at_utc, btrim(item.source), btrim(item.event_type), upper(btrim(item.status)), quality,
      COALESCE(item.lat, site.latitude), COALESCE(item.lon, site.longitude), COALESCE(item.payload, '{}'::jsonb)
    ) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING RETURNING id INTO event_id;
    IF NOT FOUND THEN
      deduplicated := deduplicated + 1;
      CONTINUE;
    END IF;
    ingested := ingested + 1;
    IF upper(btrim(item.status)) IN ('DOWN', 'OUTAGE', 'CRITICAL', 'POWER_LOSS') THEN
      IF aiops_auth.correlate_ingested_event(tenant, event_id, asset.domain) THEN
        created_incidents := created_incidents + 1;
      END IF;
    END IF;
    IF item.asset_id IS NOT NULL AND upper(btrim(item.status)) IN (
      'DOWN', 'OUTAGE', 'CRITICAL', 'DEGRADED', 'WARNING', 'UP', 'OK', 'NORMAL'
    ) THEN
      UPDATE public.assets a SET operational_state = CASE upper(btrim(item.status))
        WHEN 'DEGRADED' THEN 'DEGRADED' WHEN 'WARNING' THEN 'DEGRADED'
        WHEN 'UP' THEN 'UP' WHEN 'OK' THEN 'UP' WHEN 'NORMAL' THEN 'UP' ELSE 'DOWN' END
      WHERE a.tenant_id = tenant AND a.id = item.asset_id AND NOT EXISTS (
        SELECT 1 FROM public.canonical_events e WHERE e.tenant_id = tenant AND e.asset_id = a.id
          AND e.observed_at_utc > item.observed_at_utc
          AND upper(e.status) IN ('DOWN', 'OUTAGE', 'CRITICAL', 'DEGRADED', 'WARNING', 'UP', 'OK', 'NORMAL')
      );
    END IF;
  END LOOP;

  run_end := clock_timestamp();
  INSERT INTO public.connector_sync_runs (
    tenant_id, connector_id, started_at_utc, finished_at_utc, status, records_ingested, records_deduplicated,
    latency_ms, raw_metadata_json
  ) VALUES (
    tenant, connector, run_start, run_end, 'SUCCESS', ingested, deduplicated,
    round(extract(epoch FROM run_end - run_start) * 1000)::integer,
    jsonb_build_object('mode', 'authenticated_ingest', 'created_incidents', created_incidents)
  ) RETURNING id INTO run_id;
  UPDATE public.connectors SET
    status = CASE WHEN connector_type = 'webhook_csv' THEN 'HEALTHY' ELSE status END,
    last_error = CASE WHEN connector_type = 'webhook_csv' THEN NULL ELSE last_error END,
    last_sync_at_utc = run_end, updated_at_utc = run_end
    WHERE id = connector AND tenant_id = tenant;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
    VALUES (tenant, actor.actor_id, actor.actor_role, 'CONNECTOR_EVENTS_INGESTED', 'connector', connector::text,
      jsonb_build_object('run_id', run_id, 'ingested', ingested, 'deduplicated', deduplicated, 'created_incidents', created_incidents));
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION aiops_auth.require_ingest_actor(text, uuid),
  aiops_auth.correlate_ingested_event(uuid, uuid, text), aiops_auth.create_event_connector(text, uuid, text),
  aiops_auth.ingest_connector_events(text, uuid, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.create_event_connector(text, uuid, text),
  aiops_auth.ingest_connector_events(text, uuid, uuid, jsonb) TO aiops_authenticator;
