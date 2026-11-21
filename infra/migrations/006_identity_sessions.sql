ALTER TABLE public.users
  ADD CONSTRAINT users_role_tenant_check CHECK ((role = 'super_admin') = (tenant_id IS NULL)),
  ADD CONSTRAINT users_id_role_key UNIQUE (id, role),
  ADD CONSTRAINT users_id_tenant_id_key UNIQUE (id, tenant_id);

CREATE TABLE public.sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  user_role TEXT NOT NULL,
  tenant_id UUID,
  admin_tenant_id UUID REFERENCES public.tenants (id) ON DELETE SET NULL,
  active_tenant_id UUID GENERATED ALWAYS AS (COALESCE(tenant_id, admin_tenant_id)) STORED,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at_utc TIMESTAMPTZ NOT NULL,
  created_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT sessions_user_role_fkey FOREIGN KEY (user_id, user_role)
    REFERENCES public.users (id, role) ON DELETE CASCADE,
  CONSTRAINT sessions_user_tenant_fkey FOREIGN KEY (user_id, tenant_id)
    REFERENCES public.users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sessions_role_scope_check CHECK (
    (user_role = 'super_admin' AND tenant_id IS NULL)
    OR (user_role <> 'super_admin' AND tenant_id IS NOT NULL AND admin_tenant_id IS NULL)
  ),
  CONSTRAINT sessions_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT sessions_expiration_check CHECK (expires_at_utc > created_at_utc)
);

CREATE INDEX idx_sessions_user ON public.sessions (user_id);
CREATE INDEX idx_sessions_expiration ON public.sessions (expires_at_utc);
CREATE INDEX idx_sessions_admin_tenant ON public.sessions (admin_tenant_id)
  WHERE admin_tenant_id IS NOT NULL;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sessions FROM PUBLIC;

DO $$
BEGIN
  IF has_any_column_privilege('aiops_tenant_reader', 'public.users', 'SELECT')
    OR has_any_column_privilege('aiops_tenant_reader', 'public.sessions', 'SELECT')
    OR has_table_privilege('aiops_tenant_reader', 'public.sessions', 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    OR has_any_column_privilege('aiops_tenant_reader', 'public.sessions', 'INSERT, UPDATE, REFERENCES')
  THEN
    RAISE EXCEPTION 'O papel de leitura de tenants não deve ter acesso a identidades e sessões';
  END IF;
END $$;
