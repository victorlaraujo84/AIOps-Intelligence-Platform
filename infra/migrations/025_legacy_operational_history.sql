ALTER TABLE public.incidents ADD UNIQUE (tenant_id, id);
ALTER TABLE public.canonical_events ADD UNIQUE (tenant_id, id);

CREATE TABLE public.connector_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  connector_id uuid NOT NULL,
  started_at_utc timestamptz NOT NULL,
  finished_at_utc timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'ERROR')),
  records_ingested integer NOT NULL DEFAULT 0,
  records_deduplicated integer NOT NULL DEFAULT 0,
  latency_ms integer,
  error_message text,
  raw_metadata_json jsonb NOT NULL DEFAULT '{}',
  FOREIGN KEY (tenant_id, connector_id) REFERENCES public.connectors (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE public.incident_events (
  incident_id uuid NOT NULL,
  event_id uuid NOT NULL,
  tenant_id uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  role_in_incident text NOT NULL DEFAULT 'symptom',
  PRIMARY KEY (incident_id, event_id),
  FOREIGN KEY (tenant_id, incident_id) REFERENCES public.incidents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, event_id) REFERENCES public.canonical_events (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE public.ai_agent_configs (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants (id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'offline' CHECK (mode IN ('offline', 'openai', 'ollama')),
  endpoint_url text,
  encrypted_api_key text,
  model_name text,
  data_sharing_authorized boolean NOT NULL DEFAULT false,
  timeout_ms integer NOT NULL DEFAULT 15000,
  updated_by uuid REFERENCES public.users (id) ON DELETE SET NULL,
  updated_at_utc timestamptz NOT NULL
);

ALTER TABLE public.connector_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.incident_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_agent_configs ENABLE ROW LEVEL SECURITY;
