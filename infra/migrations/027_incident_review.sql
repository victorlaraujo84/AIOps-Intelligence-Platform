CREATE POLICY incident_events_tenant_read ON public.incident_events
  FOR SELECT TO aiops_tenant_reader
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT ON public.incident_events TO aiops_tenant_reader;

CREATE FUNCTION aiops_auth.review_incident(
  digest text, expected_tenant uuid, incident_id uuid, expected_review timestamptz,
  new_category text, new_status text, review_note text
)
RETURNS TABLE (status text, rca_category text, human_reviewed_at_utc timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  actor record;
  prior record;
  reviewed_at timestamptz;
  next_status text;
  next_category text;
BEGIN
  -- Serialize with tenant switches and session revocation.
  PERFORM 1 FROM public.sessions s WHERE s.token_hash = digest FOR UPDATE;
  SELECT * INTO actor FROM aiops_auth.find_session(digest);
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '28000', MESSAGE = 'Sessão inválida';
  END IF;
  IF actor.role NOT IN ('super_admin', 'tenant_admin', 'tenant_operator') THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Permissão insuficiente para revisar RCA';
  END IF;
  IF actor.active_tenant_id IS NULL OR actor.active_tenant_id IS DISTINCT FROM expected_tenant THEN
    RAISE EXCEPTION USING ERRCODE = 'P1001', MESSAGE = 'Tenant ativo mudou';
  END IF;
  IF new_category NOT IN ('eletrica', 'climatica_direta', 'composta', 'telecom_outros',
                         'ti_aplicacao', 'iot_sensor', 'desconhecida')
     OR new_status NOT IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')
     OR length(review_note) > 4000
     OR (new_category IS NULL AND new_status IS NULL AND NULLIF(btrim(review_note), '') IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Revisão inválida';
  END IF;

  SELECT i.status, i.rca_category, i.human_reviewed_at_utc
    INTO prior
    FROM public.incidents i
    WHERE i.id = incident_id AND i.tenant_id = expected_tenant
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P1003', MESSAGE = 'Incidente não encontrado';
  END IF;
  IF prior.human_reviewed_at_utc IS DISTINCT FROM expected_review THEN
    RAISE EXCEPTION USING ERRCODE = 'P1005', MESSAGE = 'Incidente já revisado';
  END IF;

  reviewed_at := GREATEST(clock_timestamp(), prior.human_reviewed_at_utc + interval '1 microsecond');
  next_status := COALESCE(new_status, prior.status);
  next_category := COALESCE(new_category, prior.rca_category);
  UPDATE public.incidents i
    SET status = next_status, rca_category = next_category,
        human_reviewed_by = actor.id, human_reviewed_at_utc = reviewed_at,
        resolved_at_utc = CASE WHEN next_status = 'RESOLVED' THEN COALESCE(i.resolved_at_utc, reviewed_at) END,
        rca_evidence_json = CASE
          WHEN NULLIF(btrim(review_note), '') IS NULL THEN i.rca_evidence_json
          ELSE i.rca_evidence_json || jsonb_build_array(jsonb_build_object(
            'type', 'human_review', 'note', btrim(review_note), 'actor_id', actor.id, 'reviewed_at_utc', reviewed_at
          ))
        END
    WHERE i.id = incident_id AND i.tenant_id = expected_tenant;

  INSERT INTO public.audit_logs (tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, details_json)
    VALUES (expected_tenant, actor.id, actor.role, 'INCIDENT_RCA_REVIEWED', 'incident', incident_id::text,
            jsonb_build_object('previous_status', prior.status, 'status', next_status,
                               'previous_category', prior.rca_category, 'rca_category', next_category));
  RETURN QUERY SELECT next_status, next_category, reviewed_at;
END $$;

REVOKE ALL ON FUNCTION aiops_auth.review_incident(text, uuid, uuid, timestamptz, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION aiops_auth.review_incident(text, uuid, uuid, timestamptz, text, text, text) TO aiops_authenticator;
