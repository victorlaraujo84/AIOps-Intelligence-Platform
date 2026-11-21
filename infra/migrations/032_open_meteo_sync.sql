CREATE TABLE public.open_meteo_scopes (
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  connector_id uuid NOT NULL,
  site_id uuid NOT NULL,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  enabled boolean NOT NULL DEFAULT true,
  revision uuid NOT NULL DEFAULT gen_random_uuid(),
  PRIMARY KEY (tenant_id, connector_id),
  UNIQUE (tenant_id, site_id),
  FOREIGN KEY (tenant_id, connector_id) REFERENCES public.connectors (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, site_id) REFERENCES public.sites (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE public.open_meteo_scopes ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION aiops_auth.configure_open_meteo(digest text, tenant uuid, site uuid, connector_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  point record;
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
  SELECT s.latitude, s.longitude INTO point FROM public.sites s
    WHERE s.tenant_id = tenant AND s.id = site AND s.coord_verified
      AND s.latitude BETWEEN -90 AND 90 AND s.longitude BETWEEN -180 AND 180
    FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'Site sem coordenadas verificadas'; END IF;
  SELECT x.connector_id INTO connector FROM public.open_meteo_scopes x WHERE x.tenant_id = tenant AND x.site_id = site;
  IF connector IS NULL THEN
    INSERT INTO public.connectors (tenant_id, connector_type, name, status)
      VALUES (tenant, 'open_meteo', btrim(connector_name), 'CONFIGURED') RETURNING id INTO connector;
    INSERT INTO public.open_meteo_scopes (tenant_id, connector_id, site_id, latitude, longitude)
      VALUES (tenant, connector, site, point.latitude, point.longitude);
  ELSE
    UPDATE public.open_meteo_scopes x SET latitude = point.latitude, longitude = point.longitude,
      enabled = true, revision = gen_random_uuid() WHERE x.tenant_id = tenant AND x.connector_id = connector;
    UPDATE public.connectors c SET name = btrim(connector_name), status = 'CONFIGURED', last_error = NULL,
      updated_at_utc = clock_timestamp() WHERE c.tenant_id = tenant AND c.id = connector;
  END IF;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
    VALUES (tenant, actor.actor_id, actor.actor_role, 'OPEN_METEO_CONFIGURED', 'connector', connector::text);
  RETURN connector;
END $$;

CREATE FUNCTION aiops_auth.disable_open_meteo(digest text, tenant uuid, connector uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE actor record;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  IF actor.actor_role NOT IN ('super_admin', 'tenant_admin') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Acesso restrito aos administradores';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  UPDATE public.open_meteo_scopes x SET enabled = false, revision = gen_random_uuid()
    WHERE x.tenant_id = tenant AND x.connector_id = connector;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Conector indisponível'; END IF;
  UPDATE public.connectors c SET status = 'DISABLED', updated_at_utc = clock_timestamp()
    WHERE c.tenant_id = tenant AND c.id = connector;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id)
    VALUES (tenant, actor.actor_id, actor.actor_role, 'OPEN_METEO_DISABLED', 'connector', connector::text);
  RETURN true;
END $$;

CREATE FUNCTION aiops_auth.begin_open_meteo(digest text, tenant uuid, connector uuid)
RETURNS TABLE (run_id uuid, latitude double precision, longitude double precision)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  scope record;
  started timestamptz := clock_timestamp();
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  SELECT x.site_id, x.latitude, x.longitude, x.revision INTO scope
    FROM public.open_meteo_scopes x
    JOIN public.sites s ON s.tenant_id = x.tenant_id AND s.id = x.site_id
    WHERE x.tenant_id = tenant AND x.connector_id = connector AND x.enabled
      AND s.coord_verified AND s.latitude = x.latitude AND s.longitude = x.longitude;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Conector sem autorização de coleta vigente'; END IF;

  UPDATE public.connector_sync_runs r SET status = 'ERROR', finished_at_utc = started,
    error_message = 'SYNC_INTERRUPTED'
    WHERE r.tenant_id = tenant AND r.connector_id = connector AND r.status = 'RUNNING'
      AND r.raw_metadata_json->>'mode' = 'open_meteo_current' AND r.started_at_utc <= started - interval '30 seconds';

  IF EXISTS (SELECT 1 FROM public.connector_sync_runs r WHERE r.tenant_id = tenant AND r.connector_id = connector
      AND r.started_at_utc > started - interval '30 seconds' AND r.raw_metadata_json->>'mode' = 'open_meteo_current') THEN
    RAISE EXCEPTION USING ERRCODE = 'P1032', MESSAGE = 'Aguarde antes de sincronizar novamente';
  END IF;
  INSERT INTO public.connector_sync_runs (tenant_id, connector_id, started_at_utc, status, raw_metadata_json)
    VALUES (tenant, connector, started, 'RUNNING',
      jsonb_build_object('mode', 'open_meteo_current', 'actor_id', actor.actor_id, 'revision', scope.revision))
    RETURNING id INTO run_id;
  RETURN QUERY SELECT run_id, scope.latitude, scope.longitude;
END $$;

CREATE FUNCTION aiops_auth.finish_open_meteo(
  digest text, tenant uuid, connector uuid, run uuid, observed timestamptz, current_values jsonb, failure text
)
RETURNS TABLE (run_id uuid, status text, ingested integer, deduplicated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  job record;
  site uuid;
  finished timestamptz := clock_timestamp();
  record_count integer := 0;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  SELECT r.started_at_utc, r.raw_metadata_json->>'revision' AS revision INTO job
    FROM public.connector_sync_runs r WHERE r.tenant_id = tenant AND r.connector_id = connector AND r.id = run
      AND r.status = 'RUNNING' AND r.raw_metadata_json->>'mode' = 'open_meteo_current'
      AND r.raw_metadata_json->>'actor_id' = actor.actor_id::text
    FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Execução indisponível'; END IF;
  SELECT x.site_id INTO site
    FROM public.open_meteo_scopes x JOIN public.sites s ON s.tenant_id = x.tenant_id AND s.id = x.site_id
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
    VALUES (tenant, actor.actor_id, actor.actor_role, 'OPEN_METEO_SYNC_FINISHED', 'connector', connector::text,
      jsonb_build_object('run_id', run, 'status', status, 'ingested', ingested, 'deduplicated', deduplicated, 'error_code', failure));
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION aiops_auth.configure_open_meteo(text, uuid, uuid, text),
  aiops_auth.disable_open_meteo(text, uuid, uuid), aiops_auth.begin_open_meteo(text, uuid, uuid),
  aiops_auth.finish_open_meteo(text, uuid, uuid, uuid, timestamptz, jsonb, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.configure_open_meteo(text, uuid, uuid, text),
  aiops_auth.disable_open_meteo(text, uuid, uuid), aiops_auth.begin_open_meteo(text, uuid, uuid),
  aiops_auth.finish_open_meteo(text, uuid, uuid, uuid, timestamptz, jsonb, text) TO aiops_authenticator;
