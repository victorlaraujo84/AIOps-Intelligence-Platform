ALTER TABLE public.open_meteo_scopes
  ADD COLUMN interval_minutes integer CHECK (interval_minutes IN (15, 30, 60, 180)),
  ADD COLUMN next_run_at_utc timestamptz,
  ADD CHECK ((interval_minutes IS NULL) = (next_run_at_utc IS NULL));

CREATE INDEX open_meteo_due_idx ON public.open_meteo_scopes (next_run_at_utc, tenant_id, connector_id)
  WHERE enabled AND next_run_at_utc IS NOT NULL;

CREATE INDEX connector_sync_runs_weather_lease_idx ON public.connector_sync_runs (started_at_utc, id)
  WHERE status = 'RUNNING' AND raw_metadata_json->>'mode' = 'open_meteo_current' AND raw_metadata_json ? 'lease';

CREATE SCHEMA aiops_weather;
REVOKE ALL ON SCHEMA aiops_weather FROM PUBLIC;

DO $$
BEGIN
  BEGIN
    CREATE ROLE aiops_weather_worker NOLOGIN NOINHERIT NOSUPERUSER
      NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN
    NULL;
  END;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'aiops_weather_worker'
      AND NOT (r.rolcanlogin OR r.rolinherit OR r.rolsuper OR r.rolcreatedb
               OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid)
  ) OR has_schema_privilege('aiops_weather_worker', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'Papel aiops_weather_worker com privilégios incompatíveis';
  END IF;
END $$;

CREATE FUNCTION aiops_weather.invalidate_schedule()
RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.interval_minutes := NULL;
  NEW.next_run_at_utc := NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER open_meteo_invalidate_schedule
BEFORE UPDATE OF enabled, latitude, longitude ON public.open_meteo_scopes
FOR EACH ROW WHEN (NOT NEW.enabled OR NEW.latitude IS DISTINCT FROM OLD.latitude OR NEW.longitude IS DISTINCT FROM OLD.longitude)
EXECUTE FUNCTION aiops_weather.invalidate_schedule();

CREATE FUNCTION aiops_auth.open_meteo_schedule(digest text, tenant uuid, connector uuid)
RETURNS TABLE (interval_minutes integer, next_run_at_utc timestamptz, scope_valid boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO actor FROM aiops_auth.find_session(digest);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida';
  END IF;
  IF actor.active_tenant_id IS NULL OR actor.active_tenant_id IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Tenant ativo mudou';
  END IF;
  RETURN QUERY
    SELECT x.interval_minutes, x.next_run_at_utc,
      x.enabled AND s.coord_verified AND COALESCE(s.latitude = x.latitude AND s.longitude = x.longitude, false)
    FROM public.open_meteo_scopes x
    JOIN public.sites s ON s.id = x.site_id AND s.tenant_id = x.tenant_id
    WHERE x.tenant_id = tenant AND x.connector_id = connector;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Conector sem escopo climático'; END IF;
END $$;

CREATE FUNCTION aiops_auth.set_open_meteo_schedule(digest text, tenant uuid, connector uuid, minutes integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  IF actor.actor_role NOT IN ('super_admin', 'tenant_admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito aos administradores';
  END IF;
  IF minutes NOT IN (15, 30, 60, 180) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Intervalo inválido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  UPDATE public.open_meteo_scopes x SET
    interval_minutes = minutes,
    next_run_at_utc = CASE WHEN minutes IS NOT NULL THEN clock_timestamp() END,
    revision = gen_random_uuid()
    FROM public.sites s
    WHERE x.tenant_id = tenant AND x.connector_id = connector AND s.tenant_id = x.tenant_id AND s.id = x.site_id
      AND (minutes IS NULL OR (x.enabled AND s.coord_verified AND s.latitude = x.latitude AND s.longitude = x.longitude));
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Conector sem escopo válido'; END IF;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
    VALUES (tenant, actor.actor_id, actor.actor_role, 'OPEN_METEO_SCHEDULE_CHANGED', 'connector', connector::text,
            jsonb_build_object('interval_minutes', minutes));
  RETURN true;
END $$;

CREATE FUNCTION aiops_weather.claim_due()
RETURNS TABLE (
  tenant_id uuid, connector_id uuid, run_id uuid, lease uuid, latitude double precision, longitude double precision
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  candidate record;
  scope record;
  started timestamptz := clock_timestamp();
BEGIN
  WITH expired AS (
    SELECT r.id FROM public.connector_sync_runs r
     WHERE r.status = 'RUNNING' AND r.raw_metadata_json->>'mode' = 'open_meteo_current'
       AND r.raw_metadata_json ? 'lease' AND r.started_at_utc <= started - interval '30 seconds'
     ORDER BY r.started_at_utc, r.id LIMIT 20 FOR UPDATE SKIP LOCKED
  )
  UPDATE public.connector_sync_runs r SET status = 'ERROR', finished_at_utc = started, error_message = 'SYNC_INTERRUPTED'
    FROM expired WHERE r.id = expired.id;

  FOR candidate IN
    SELECT x.tenant_id, x.connector_id
    FROM public.open_meteo_scopes x
    JOIN public.tenants t ON t.id = x.tenant_id AND t.status = 'active'
    JOIN public.sites s ON s.id = x.site_id AND s.tenant_id = x.tenant_id
    WHERE x.enabled AND x.next_run_at_utc <= started
      AND s.coord_verified AND s.latitude = x.latitude AND s.longitude = x.longitude
      AND NOT EXISTS (
        SELECT 1 FROM public.connector_sync_runs r WHERE r.tenant_id = x.tenant_id AND r.connector_id = x.connector_id
          AND r.started_at_utc > started - interval '30 seconds' AND r.raw_metadata_json->>'mode' = 'open_meteo_current'
      )
    ORDER BY x.next_run_at_utc, x.tenant_id, x.connector_id LIMIT 20
  LOOP
    IF NOT pg_try_advisory_xact_lock(hashtextextended(candidate.tenant_id::text, 12015)) THEN CONTINUE; END IF;
    SELECT x.revision, x.latitude, x.longitude INTO scope
      FROM public.open_meteo_scopes x
      JOIN public.tenants t ON t.id = x.tenant_id AND t.status = 'active'
      JOIN public.sites s ON s.id = x.site_id AND s.tenant_id = x.tenant_id
      WHERE x.tenant_id = candidate.tenant_id AND x.connector_id = candidate.connector_id
        AND x.enabled AND x.next_run_at_utc <= started
        AND s.coord_verified AND s.latitude = x.latitude AND s.longitude = x.longitude
      FOR SHARE OF s;
    IF NOT FOUND OR EXISTS (
      SELECT 1 FROM public.connector_sync_runs r
      WHERE r.tenant_id = candidate.tenant_id AND r.connector_id = candidate.connector_id
        AND r.started_at_utc > started - interval '30 seconds' AND r.raw_metadata_json->>'mode' = 'open_meteo_current'
    ) THEN CONTINUE; END IF;

    UPDATE public.connector_sync_runs r SET status = 'ERROR', finished_at_utc = started, error_message = 'SYNC_INTERRUPTED'
      WHERE r.tenant_id = candidate.tenant_id AND r.connector_id = candidate.connector_id AND r.status = 'RUNNING'
        AND r.raw_metadata_json->>'mode' = 'open_meteo_current' AND r.started_at_utc <= started - interval '30 seconds';
    tenant_id := candidate.tenant_id;
    connector_id := candidate.connector_id;
    latitude := scope.latitude;
    longitude := scope.longitude;
    lease := gen_random_uuid();
    INSERT INTO public.connector_sync_runs (tenant_id, connector_id, started_at_utc, status, raw_metadata_json)
      VALUES (candidate.tenant_id, candidate.connector_id, started, 'RUNNING',
              jsonb_build_object('mode', 'open_meteo_current', 'lease', lease, 'revision', scope.revision))
      RETURNING id INTO run_id;
    UPDATE public.open_meteo_scopes x SET next_run_at_utc = started + interval '1 minute'
      WHERE x.tenant_id = candidate.tenant_id AND x.connector_id = candidate.connector_id;
    RETURN NEXT;
    RETURN;
  END LOOP;
END $$;

CREATE FUNCTION aiops_weather.finish_open_meteo(
  actor_id uuid, actor_role text, expected_lease uuid, tenant uuid, connector uuid, run uuid,
  observed timestamptz, current_values jsonb, failure text
)
RETURNS TABLE (run_id uuid, status text, ingested integer, deduplicated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  job record;
  site uuid;
  finished timestamptz := clock_timestamp();
  record_count integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  SELECT r.started_at_utc, r.raw_metadata_json->>'revision' AS revision INTO job
    FROM public.connector_sync_runs r WHERE r.tenant_id = tenant AND r.connector_id = connector AND r.id = run
      AND r.status = 'RUNNING' AND r.raw_metadata_json->>'mode' = 'open_meteo_current'
      AND ((actor_id IS NOT NULL AND r.raw_metadata_json->>'actor_id' = actor_id::text)
           OR (expected_lease IS NOT NULL AND r.raw_metadata_json->>'lease' = expected_lease::text))
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Execução indisponível'; END IF;
  SELECT x.site_id INTO site
    FROM public.open_meteo_scopes x JOIN public.sites s ON s.tenant_id = x.tenant_id AND s.id = x.site_id
    JOIN public.tenants t ON t.id = x.tenant_id AND t.status = 'active'
    WHERE x.tenant_id = tenant AND x.connector_id = connector AND x.enabled AND x.revision::text = job.revision
      AND s.coord_verified AND s.latitude = x.latitude AND s.longitude = x.longitude FOR SHARE OF s;
  IF NOT FOUND THEN
    failure := 'SCOPE_CHANGED';
  ELSIF finished >= job.started_at_utc + interval '30 seconds' THEN
    failure := 'SYNC_INTERRUPTED';
  ELSIF failure IS NOT NULL AND failure NOT IN ('UPSTREAM_UNAVAILABLE', 'UPSTREAM_INVALID') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Resultado de coleta inválido';
  END IF;

  ingested := 0;
  deduplicated := 0;
  IF failure IS NULL THEN
    IF observed IS NULL OR NOT isfinite(observed) OR jsonb_typeof(current_values) IS DISTINCT FROM 'object'
      OR current_values = '{}'::jsonb THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Dados climáticos inválidos';
    END IF;
    SELECT count(*) INTO record_count FROM jsonb_each(current_values) e
      WHERE e.key IN ('temperature_2m', 'precipitation', 'wind_gusts_10m', 'surface_pressure')
        AND jsonb_typeof(e.value) = 'number';
    IF record_count = 0 OR record_count <> (SELECT count(*) FROM jsonb_each(current_values)) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Variáveis climáticas inválidas';
    END IF;

    WITH samples AS (
      SELECT v.metric, v.unit, (current_values->>v.metric)::double precision AS value,
        'open_meteo_m:' || site || ':' || v.metric || ':' ||
        to_char(observed AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS metric_key
      FROM (VALUES ('temperature_2m', '°C'), ('precipitation', 'mm'), ('wind_gusts_10m', 'km/h'), ('surface_pressure', 'hPa')) v(metric, unit)
      WHERE current_values ? v.metric
    )
    INSERT INTO public.metric_samples (
      tenant_id, site_id, connector_id, idempotency_key, metric_name, value_num, unit, observed_at_utc, source, tags_json
    )
    SELECT tenant, site, connector, s.metric_key, 'weather_' || s.metric, s.value, s.unit, observed, 'open_meteo',
      '{"data_kind":"modelled_current_conditions"}'::jsonb
    FROM samples s WHERE NOT EXISTS (
      SELECT 1 FROM public.metric_samples m WHERE m.tenant_id = tenant AND m.idempotency_key = s.metric_key
    )
    ON CONFLICT (tenant_id, observed_at_utc, idempotency_key) DO NOTHING;
    GET DIAGNOSTICS ingested = ROW_COUNT;
    deduplicated := record_count - ingested;
  END IF;

  run_id := run;
  status := CASE WHEN failure IS NULL THEN 'SUCCESS' ELSE 'ERROR' END;
  UPDATE public.connector_sync_runs r SET status = finish_open_meteo.status, finished_at_utc = finished,
    records_ingested = ingested, records_deduplicated = deduplicated, error_message = failure,
    latency_ms = round(extract(epoch FROM finished - job.started_at_utc) * 1000)::integer
    WHERE r.tenant_id = tenant AND r.id = run;
  IF failure IS DISTINCT FROM 'SCOPE_CHANGED' THEN
    UPDATE public.connectors c SET status = CASE WHEN failure IS NULL THEN 'HEALTHY' ELSE 'ERROR' END,
      last_sync_at_utc = CASE WHEN failure IS NULL THEN finished ELSE c.last_sync_at_utc END,
      last_error = failure, updated_at_utc = finished WHERE c.tenant_id = tenant AND c.id = connector;
  END IF;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
    VALUES (tenant, actor_id, actor_role, 'OPEN_METEO_SYNC_FINISHED', 'connector', connector::text,
      jsonb_build_object('run_id', run, 'status', status, 'ingested', ingested, 'deduplicated', deduplicated, 'error_code', failure));
  IF expected_lease IS NOT NULL AND failure IS DISTINCT FROM 'SCOPE_CHANGED' THEN
    UPDATE public.open_meteo_scopes x
      SET next_run_at_utc = finished + make_interval(mins => CASE WHEN failure IS NULL THEN x.interval_minutes ELSE 5 END)
      WHERE x.tenant_id = tenant AND x.connector_id = connector AND x.revision::text = job.revision
        AND x.enabled AND x.interval_minutes IS NOT NULL;
  END IF;
  RETURN NEXT;
END $$;

CREATE OR REPLACE FUNCTION aiops_auth.finish_open_meteo(
  digest text, tenant uuid, connector uuid, run uuid, observed timestamptz, current_values jsonb, failure text
)
RETURNS TABLE (run_id uuid, status text, ingested integer, deduplicated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  RETURN QUERY SELECT * FROM aiops_weather.finish_open_meteo(
    actor.actor_id, actor.actor_role, NULL, tenant, connector, run, observed, current_values, failure
  );
END $$;

CREATE FUNCTION aiops_weather.complete_due(
  tenant uuid, connector uuid, run uuid, lease uuid, observed timestamptz, current_values jsonb, failure text
)
RETURNS TABLE (run_id uuid, status text, ingested integer, deduplicated integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT * FROM aiops_weather.finish_open_meteo(
    NULL, NULL, lease, tenant, connector, run, observed, current_values, failure
  )
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA aiops_weather FROM PUBLIC;
REVOKE ALL ON FUNCTION aiops_auth.open_meteo_schedule(text, uuid, uuid),
  aiops_auth.set_open_meteo_schedule(text, uuid, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.open_meteo_schedule(text, uuid, uuid),
  aiops_auth.set_open_meteo_schedule(text, uuid, uuid, integer) TO aiops_authenticator;
GRANT USAGE ON SCHEMA aiops_weather TO aiops_weather_worker;
GRANT EXECUTE ON FUNCTION aiops_weather.claim_due(),
  aiops_weather.complete_due(uuid, uuid, uuid, uuid, timestamptz, jsonb, text) TO aiops_weather_worker;
