-- The partitioned table can only enforce uniqueness with the partition timestamp.
-- This index supports tenant-wide key lookups, including imported records.
CREATE INDEX metric_samples_tenant_ingest_key_idx ON public.metric_samples (tenant_id, idempotency_key);

CREATE FUNCTION aiops_auth.ingest_connector_telemetry(
  digest text, tenant uuid, connector uuid, signal_kind text, samples jsonb
)
RETURNS TABLE (run_id uuid, ingested integer, deduplicated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  sample record;
  asset_site uuid;
  resolved_site uuid;
  started timestamptz := clock_timestamp();
  finished timestamptz;
BEGIN
  SELECT * INTO STRICT actor FROM aiops_auth.require_ingest_actor(digest, tenant);
  IF signal_kind IS NULL OR signal_kind NOT IN ('metrics', 'logs')
     OR jsonb_typeof(samples) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Lote de telemetria inválido';
  END IF;
  IF jsonb_array_length(samples) NOT BETWEEN 1 AND 100 OR octet_length(samples::text) > 524288 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Lote de telemetria inválido';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(tenant::text, 12015));
  PERFORM 1 FROM public.connectors c WHERE c.tenant_id = tenant AND c.id = connector AND c.status <> 'DISABLED' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1030', MESSAGE = 'Conector indisponível';
  END IF;

  ingested := 0;
  deduplicated := 0;
  FOR sample IN SELECT * FROM jsonb_to_recordset(samples) AS s(
    idempotency_key text, source text, observed_at_utc timestamptz, asset_id uuid, service_id uuid, site_id uuid,
    metric_name text, value_num double precision, unit text, quality_flag text, tags jsonb,
    severity text, message text, trace_id text, attributes jsonb
  ) LOOP
    IF length(btrim(COALESCE(sample.idempotency_key, ''))) NOT BETWEEN 1 AND 200
       OR length(btrim(COALESCE(sample.source, ''))) NOT BETWEEN 1 AND 120
       OR sample.observed_at_utc IS NULL OR NOT isfinite(sample.observed_at_utc) THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Registro de telemetria inválido';
    END IF;

    asset_site := NULL;
    IF sample.asset_id IS NOT NULL THEN
      SELECT a.site_id INTO asset_site FROM public.assets a WHERE a.tenant_id = tenant AND a.id = sample.asset_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'Ativo indisponível neste tenant';
      END IF;
    END IF;
    IF asset_site IS NOT NULL AND sample.site_id IS NOT NULL AND asset_site <> sample.site_id THEN
      RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'O site difere do cadastro do ativo';
    END IF;
    resolved_site := COALESCE(asset_site, sample.site_id);
    IF resolved_site IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.sites s WHERE s.tenant_id = tenant AND s.id = resolved_site
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'Site indisponível neste tenant';
    END IF;
    IF sample.service_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.services s WHERE s.tenant_id = tenant AND s.id = sample.service_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'P1031', MESSAGE = 'Serviço indisponível neste tenant';
    END IF;

    IF signal_kind = 'metrics' THEN
      IF length(btrim(COALESCE(sample.metric_name, ''))) NOT BETWEEN 1 AND 120
         OR length(btrim(COALESCE(sample.unit, ''))) NOT BETWEEN 1 AND 120
         OR sample.value_num IS NULL OR sample.value_num IN ('NaN'::double precision, 'Infinity'::double precision, '-Infinity'::double precision)
         OR COALESCE(sample.quality_flag, 'VALID') NOT IN ('VALID', 'STALE', 'SUSPECT', 'UNVERIFIED_COORDS')
         OR (sample.tags IS NOT NULL AND jsonb_typeof(sample.tags) <> 'object') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Amostra de métrica inválida';
      END IF;
      INSERT INTO public.metric_samples (
        tenant_id, asset_id, service_id, site_id, connector_id, idempotency_key, metric_name,
        value_num, unit, observed_at_utc, source, quality_flag, tags_json
      )
      SELECT tenant, sample.asset_id, sample.service_id, resolved_site, connector, btrim(sample.idempotency_key),
        btrim(sample.metric_name), sample.value_num, btrim(sample.unit), sample.observed_at_utc,
        btrim(sample.source), COALESCE(sample.quality_flag, 'VALID'), COALESCE(sample.tags, '{}'::jsonb)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.metric_samples m WHERE m.tenant_id = tenant AND m.idempotency_key = btrim(sample.idempotency_key)
      )
      ON CONFLICT (tenant_id, observed_at_utc, idempotency_key) DO NOTHING;
    ELSE
      IF sample.severity IS NULL OR sample.severity NOT IN ('DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL')
         OR length(COALESCE(sample.message, '')) NOT BETWEEN 1 AND 16000
         OR btrim(sample.message) = '' OR length(sample.trace_id) > 128
         OR (sample.attributes IS NOT NULL AND jsonb_typeof(sample.attributes) <> 'object') THEN
        RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Log inválido';
      END IF;
      INSERT INTO public.operational_logs (
        tenant_id, asset_id, service_id, site_id, connector_id, idempotency_key,
        severity, message, observed_at_utc, source, trace_id, attributes_json
      ) VALUES (
        tenant, sample.asset_id, sample.service_id, resolved_site, connector, btrim(sample.idempotency_key),
        sample.severity, sample.message, sample.observed_at_utc, btrim(sample.source), sample.trace_id, COALESCE(sample.attributes, '{}'::jsonb)
      ) ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
    END IF;
    IF FOUND THEN
      ingested := ingested + 1;
    ELSE
      deduplicated := deduplicated + 1;
    END IF;
  END LOOP;

  finished := clock_timestamp();
  INSERT INTO public.connector_sync_runs (
    tenant_id, connector_id, started_at_utc, finished_at_utc, status, records_ingested, records_deduplicated,
    latency_ms, raw_metadata_json
  ) VALUES (
    tenant, connector, started, finished, 'SUCCESS', ingested, deduplicated,
    round(extract(epoch FROM finished - started) * 1000)::integer,
    jsonb_build_object('mode', 'authenticated_ingest', 'signal', signal_kind)
  ) RETURNING id INTO run_id;
  UPDATE public.connectors SET
    status = CASE WHEN connector_type = 'webhook_csv' THEN 'HEALTHY' ELSE status END,
    last_error = CASE WHEN connector_type = 'webhook_csv' THEN NULL ELSE last_error END,
    last_sync_at_utc = finished, updated_at_utc = finished
    WHERE id = connector AND tenant_id = tenant;
  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
    VALUES (tenant, actor.actor_id, actor.actor_role, 'CONNECTOR_TELEMETRY_INGESTED', 'connector', connector::text,
      jsonb_build_object('run_id', run_id, 'signal', signal_kind, 'ingested', ingested, 'deduplicated', deduplicated));
  RETURN NEXT;
END $$;

REVOKE ALL ON FUNCTION aiops_auth.ingest_connector_telemetry(text, uuid, uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.ingest_connector_telemetry(text, uuid, uuid, text, jsonb) TO aiops_authenticator;
