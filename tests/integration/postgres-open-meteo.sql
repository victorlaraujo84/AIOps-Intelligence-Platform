-- Fixtures only. No external request is made.
BEGIN;
DO $$
DECLARE
  tenant uuid := '00000000-0000-4000-9000-000000000001';
  site uuid := '00000000-0000-4000-9000-000000000005';
  imported_connector uuid := '00000000-0000-4000-9000-000000000015';
  admin uuid := '00000000-0000-4000-9000-000000000011';
  viewer uuid;
  connector uuid;
  other uuid;
  job record;
  result record;
  readings jsonb := '{"temperature_2m":12.5,"precipitation":0,"wind_gusts_10m":23,"surface_pressure":1000}';
  observed timestamptz := '2026-11-21T12:15:00Z';
BEGIN
  SELECT id INTO STRICT viewer FROM public.users WHERE email = 'release-viewer@example.invalid';
  INSERT INTO public.tenants (name, slug) VALUES ('Fixture de escopo climático', 'weather-isolation-fixture') RETURNING id INTO other;
  INSERT INTO public.sessions (user_id, user_role, admin_tenant_id, token_hash, expires_at_utc)
    VALUES (admin, 'super_admin', tenant, repeat('e', 64), now() + interval '1 hour');
  INSERT INTO public.sessions (user_id, user_role, tenant_id, token_hash, expires_at_utc)
    VALUES (viewer, 'tenant_viewer', tenant, repeat('a', 64), now() + interval '1 hour');
  SET LOCAL ROLE aiops_authenticator;
  BEGIN
    PERFORM aiops_auth.configure_open_meteo(repeat('a', 64), tenant, site, 'Bloqueado');
    RAISE EXCEPTION 'Conta de leitura conseguiu configurar o coletor';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, imported_connector);
    RAISE EXCEPTION 'Conector legado sem autorização conseguiu coletar';
  EXCEPTION WHEN SQLSTATE 'P1030' THEN NULL;
  END;
  BEGIN
    PERFORM aiops_auth.configure_open_meteo(repeat('e', 64), other, site, 'Bloqueado');
    RAISE EXCEPTION 'Tenant divergente foi aceito';
  EXCEPTION WHEN SQLSTATE 'P1001' THEN NULL;
  END;

  SELECT aiops_auth.configure_open_meteo(repeat('e', 64), tenant, site, 'Open-Meteo fixture') INTO connector;
  SELECT * INTO STRICT job FROM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, connector);
  IF job.latitude IS NULL OR job.longitude IS NULL THEN RAISE EXCEPTION 'Coordenadas ausentes'; END IF;
  BEGIN
    PERFORM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, connector);
    RAISE EXCEPTION 'Reserva de sincronização duplicada';
  EXCEPTION WHEN SQLSTATE 'P1032' THEN NULL;
  END;
  SELECT * INTO STRICT result FROM aiops_auth.finish_open_meteo(repeat('e', 64), tenant, connector, job.run_id, observed, readings, NULL);
  IF result.status <> 'SUCCESS' OR result.ingested <> 4 OR result.deduplicated <> 0 THEN
    RAISE EXCEPTION 'Ingestão climática incompleta';
  END IF;
  RESET ROLE;
  UPDATE public.connector_sync_runs r SET started_at_utc = now() - interval '1 minute' WHERE r.id = job.run_id;
  SET LOCAL ROLE aiops_authenticator;
  SELECT * INTO STRICT job FROM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, connector);
  SELECT * INTO STRICT result FROM aiops_auth.finish_open_meteo(repeat('e', 64), tenant, connector, job.run_id, observed, readings, NULL);
  IF result.status <> 'SUCCESS' OR result.ingested <> 0 OR result.deduplicated <> 4 THEN
    RAISE EXCEPTION 'Reenvio criou amostras duplicadas';
  END IF;
  RESET ROLE;
  UPDATE public.connector_sync_runs r SET started_at_utc = now() - interval '1 minute' WHERE r.id = job.run_id;
  SET LOCAL ROLE aiops_authenticator;
  SELECT * INTO STRICT job FROM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, connector);
  SELECT * INTO STRICT result FROM aiops_auth.finish_open_meteo(
    repeat('e', 64), tenant, connector, job.run_id, NULL, NULL, 'UPSTREAM_UNAVAILABLE'
  );
  IF result.status <> 'ERROR' OR result.ingested <> 0 THEN
    RAISE EXCEPTION 'Falha remota foi registrada como sucesso';
  END IF;
  RESET ROLE;
  UPDATE public.connector_sync_runs r SET started_at_utc = now() - interval '1 minute' WHERE r.id = job.run_id;
  SET LOCAL ROLE aiops_authenticator;
  SELECT * INTO STRICT job FROM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, connector);
  PERFORM aiops_auth.disable_open_meteo(repeat('e', 64), tenant, connector);
  SELECT * INTO STRICT result FROM aiops_auth.finish_open_meteo(repeat('e', 64), tenant, connector, job.run_id, observed, readings, NULL);
  IF result.status <> 'ERROR' THEN RAISE EXCEPTION 'Resultado aceito após revogação'; END IF;
  BEGIN
    PERFORM aiops_auth.begin_open_meteo(repeat('e', 64), tenant, connector);
    RAISE EXCEPTION 'Conector desativado conseguiu coletar';
  EXCEPTION WHEN SQLSTATE 'P1030' THEN NULL;
  END;
  RESET ROLE;

  IF (SELECT count(*) FROM public.metric_samples WHERE tenant_id = tenant AND connector_id = connector
      AND tags_json->>'data_kind' = 'modelled_current_conditions') <> 4
      OR NOT EXISTS (SELECT 1 FROM public.connectors c WHERE c.id = connector AND c.status = 'DISABLED')
      OR (SELECT count(*) FROM public.audit_logs WHERE tenant_id = tenant AND action = 'OPEN_METEO_SYNC_FINISHED') <> 4 THEN
    RAISE EXCEPTION 'Persistência, atribuição, revogação ou auditoria divergente';
  END IF;
END $$;
ROLLBACK;
