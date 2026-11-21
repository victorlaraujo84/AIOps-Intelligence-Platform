-- CI and isolated homologation only. The reserved .invalid origin has no real endpoint.
CREATE ROLE aiops_itsm_ci LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'itsm-ci-fixture-only';
GRANT aiops_itsm_worker TO aiops_itsm_ci;
INSERT INTO aiops_notifications.itsm_integrations (id, tenant_id, name, provider, enabled, create_ticket_verified_at)
  VALUES ('00000000-0000-4000-9000-000000000051', '00000000-0000-4000-9000-000000000001',
          'ITSM fixture', 'servicenow', true, now());
