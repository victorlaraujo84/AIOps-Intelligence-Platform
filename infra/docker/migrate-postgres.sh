#!/bin/sh
set -eu

: "${PGPASSWORD:?configure POSTGRES_PASSWORD}"
adopt_legacy=${AIOPS_POSTGRES_ADOPT_LEGACY:-false}
case "$adopt_legacy" in
  true|false) ;;
  *) printf '%s\n' 'AIOPS_POSTGRES_ADOPT_LEGACY deve ser true ou false.' >&2; exit 1 ;;
esac

cd /opt/aiops/migrations
initial=$(sha256sum 001_initial_schema.sql)
hybrid=$(sha256sum 002_hybrid_observability.sql)
reader=$(sha256sum 003_tenant_reader.sql)
links=$(sha256sum 004_tenant_links.sql)
inventory=$(sha256sum 005_inventory_parity.sql)
identity=$(sha256sum 006_identity_sessions.sql)
auth=$(sha256sum 007_authenticator.sql)
selection=$(sha256sum 008_auth_tenant_selection.sql)
exec psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
  --set="initial_sha=${initial%% *}" --set="hybrid_sha=${hybrid%% *}" \
  --set="reader_sha=${reader%% *}" --set="links_sha=${links%% *}" \
  --set="inventory_sha=${inventory%% *}" --set="identity_sha=${identity%% *}" \
  --set="auth_sha=${auth%% *}" --set="selection_sha=${selection%% *}" \
  --set="adopt_legacy=$adopt_legacy" --file=runner/apply.sql
