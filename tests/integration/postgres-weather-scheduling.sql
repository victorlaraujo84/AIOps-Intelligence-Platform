-- Synthetic PostgreSQL and lease fixtures. No requests leave the database.
BEGIN;
DO $$
DECLARE
  tenant uuid := '00000000-0000-4000-9000-000000000001';
  site uuid := '00000000-0000-4000-9000-000000000005';
  fixture_admin uuid := '00000000-0000-4000-9000-000000000011';
  operator uuid;
  connector uuid;
  job record;
  interrupted uuid;
  result record;
  next_at timestamptz;
  readings jsonb := '{"temperature_2m":13,"precipitation":0,"wind_gusts_10m":21,"surface_pressure":1001}';
BEGIN
  SELECT id INTO STRICT operator FROM public.users WHERE email = 'release-operator@example.invalid';
  INSERT INTO public.sessions (user_id, user_role, admin_tenant_id, token_hash, expires_at_utc)
    VALUES (fixture_admin, 'super_admin', tenant, repeat('c', 64), now() + interval '1 hour');
  INSERT INTO public.sessions (user_id, user_role, tenant_id, token_hash, expires_at_utc)
    VALUES (operator, 'tenant_operator', tenant, repeat('b', 64), now() + interval '1 hour');

  IF has_table_privilege('aiops_weather_worker', 'public.open_meteo_scopes', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_table_privilege('aiops_weather_worker', 'public.metric_samples', 'SELECT,INSERT,UPDATE,DELETE')
    OR has_schema_privilege('aiops_authenticator', 'aiops_weather', 'USAGE') THEN
    RAISE EXCEPTION 'Acesso direto indevido ao agendamento';
  END IF;

  SET LOCAL ROLE aiops_authenticator;
  SELECT aiops_auth.configure_open_meteo(repeat('c', 64), tenant, site, 'Agenda climática fixture') INTO connector;
  RESET ROLE;
  SET LOCAL ROLE aiops_weather_worker;
  IF EXISTS (SELECT 1 FROM aiops_weather.claim_due()) THEN RAISE EXCEPTION 'Agendamento implícito'; END IF;
  RESET ROLE;
  SET LOCAL ROLE aiops_authenticator;
  BEGIN
    PERFORM aiops_auth.set_open_meteo_schedule(repeat('b', 64), tenant, connector, 15);
    RAISE EXCEPTION 'Operador habilitou agendamento';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM aiops_auth.set_open_meteo_schedule(repeat('c', 64), tenant, connector, 15);
  IF (SELECT interval_minutes FROM aiops_auth.open_meteo_schedule(repeat('c', 64), tenant, connector)) <> 15 THEN
    RAISE EXCEPTION 'Intervalo não confirmado';
  END IF;
  RESET ROLE;

  SET LOCAL ROLE aiops_weather_worker;
  SELECT * INTO STRICT job FROM aiops_weather.claim_due();
  IF job.tenant_id <> tenant OR job.connector_id <> connector OR EXISTS (SELECT 1 FROM aiops_weather.claim_due()) THEN
    RAISE EXCEPTION 'Reserva duplicada ou fora do escopo';
  END IF;
  BEGIN
    PERFORM aiops_weather.complete_due(tenant, connector, job.run_id, gen_random_uuid(), now(), readings, NULL);
    RAISE EXCEPTION 'Lease inválido confirmou resultado';
  EXCEPTION WHEN SQLSTATE 'P1030' THEN NULL;
  END;
  SELECT * INTO STRICT result FROM aiops_weather.complete_due(tenant, connector, job.run_id, job.lease, now(), readings, NULL);
  IF result.status <> 'SUCCESS' OR result.ingested <> 4 THEN RAISE EXCEPTION 'Coleta agendada não persistida'; END IF;
  RESET ROLE;

  SELECT x.next_run_at_utc INTO STRICT next_at FROM public.open_meteo_scopes x WHERE x.tenant_id = tenant AND x.connector_id = connector;
  IF next_at < statement_timestamp() + interval '15 minutes' THEN RAISE EXCEPTION 'Intervalo de sucesso incorreto'; END IF;
  UPDATE public.open_meteo_scopes x SET next_run_at_utc = now() - interval '1 minute'
    WHERE x.tenant_id = tenant AND x.connector_id = connector;
  UPDATE public.connector_sync_runs SET started_at_utc = now() - interval '2 minutes' WHERE id = result.run_id;

  SET LOCAL ROLE aiops_weather_worker;
  SELECT * INTO STRICT job FROM aiops_weather.claim_due();
  SELECT * INTO STRICT result FROM aiops_weather.complete_due(
    tenant, connector, job.run_id, job.lease, NULL, NULL, 'UPSTREAM_UNAVAILABLE'
  );
  IF result.status <> 'ERROR' OR result.ingested <> 0 THEN RAISE EXCEPTION 'Falha de coleta registrada incorretamente'; END IF;
  RESET ROLE;
  SELECT x.next_run_at_utc INTO STRICT next_at FROM public.open_meteo_scopes x WHERE x.tenant_id = tenant AND x.connector_id = connector;
  IF next_at < statement_timestamp() + interval '5 minutes' OR next_at > clock_timestamp() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Retentativa incorreta';
  END IF;
  UPDATE public.open_meteo_scopes x SET next_run_at_utc = now() - interval '1 minute'
    WHERE x.tenant_id = tenant AND x.connector_id = connector;
  UPDATE public.connector_sync_runs SET started_at_utc = now() - interval '2 minutes' WHERE id = result.run_id;
  SET LOCAL ROLE aiops_weather_worker;
  SELECT * INTO STRICT job FROM aiops_weather.claim_due();
  interrupted := job.run_id;
  RESET ROLE;

  UPDATE public.open_meteo_scopes x SET next_run_at_utc = now() - interval '1 minute'
    WHERE x.tenant_id = tenant AND x.connector_id = connector;
  UPDATE public.connector_sync_runs SET started_at_utc = now() - interval '2 minutes' WHERE id = interrupted;
  SET LOCAL ROLE aiops_weather_worker;
  SELECT * INTO STRICT job FROM aiops_weather.claim_due();
  IF job.run_id = interrupted THEN RAISE EXCEPTION 'Execução interrompida reutilizou o lease'; END IF;
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM public.connector_sync_runs WHERE id = interrupted AND error_message = 'SYNC_INTERRUPTED') THEN
    RAISE EXCEPTION 'Execução interrompida não encerrou';
  END IF;

  SET LOCAL ROLE aiops_authenticator;
  PERFORM aiops_auth.set_open_meteo_schedule(repeat('c', 64), tenant, connector, NULL);
  RESET ROLE;
  SET LOCAL ROLE aiops_weather_worker;
  SELECT * INTO STRICT result FROM aiops_weather.complete_due(tenant, connector, job.run_id, job.lease, now(), readings, NULL);
  IF result.status <> 'ERROR' OR result.ingested <> 0 OR EXISTS (SELECT 1 FROM aiops_weather.claim_due()) THEN
    RAISE EXCEPTION 'Pausa não revogou a coleta';
  END IF;
  RESET ROLE;
END $$;
ROLLBACK;
