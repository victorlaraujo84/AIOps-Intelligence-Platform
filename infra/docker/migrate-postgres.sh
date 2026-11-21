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
site_writer=$(sha256sum 009_site_writer.sql)
asset_writer=$(sha256sum 010_asset_writer.sql)
service_writer=$(sha256sum 011_service_writer.sql)
service_dependencies=$(sha256sum 012_service_dependencies.sql)
topology_edges=$(sha256sum 013_topology_edges.sql)
asset_categories=$(sha256sum 014_asset_categories.sql)
site_catalog=$(sha256sum 015_site_catalog.sql)
site_location=$(sha256sum 016_site_location.sql)
site_map=$(sha256sum 017_site_map_index.sql)
tenant_list=$(sha256sum 018_auth_tenant_list.sql)
tenant_user_admin=$(sha256sum 019_tenant_user_admin.sql)
create_tenant=$(sha256sum 020_create_tenant.sql)
concession_delete=$(sha256sum 021_concession_delete.sql)
exec psql --no-psqlrc --no-password --set=ON_ERROR_STOP=1 \
  --set="initial_sha=${initial%% *}" --set="hybrid_sha=${hybrid%% *}" \
  --set="reader_sha=${reader%% *}" --set="links_sha=${links%% *}" \
  --set="inventory_sha=${inventory%% *}" --set="identity_sha=${identity%% *}" \
  --set="auth_sha=${auth%% *}" --set="selection_sha=${selection%% *}" \
  --set="site_writer_sha=${site_writer%% *}" --set="asset_writer_sha=${asset_writer%% *}" \
  --set="service_writer_sha=${service_writer%% *}" \
  --set="service_dependencies_sha=${service_dependencies%% *}" \
  --set="topology_edges_sha=${topology_edges%% *}" \
  --set="asset_categories_sha=${asset_categories%% *}" \
  --set="site_catalog_sha=${site_catalog%% *}" \
  --set="site_location_sha=${site_location%% *}" \
  --set="site_map_sha=${site_map%% *}" \
  --set="tenant_list_sha=${tenant_list%% *}" --set="tenant_user_admin_sha=${tenant_user_admin%% *}" \
  --set="create_tenant_sha=${create_tenant%% *}" \
  --set="concession_delete_sha=${concession_delete%% *}" \
  --set="adopt_legacy=$adopt_legacy" --file=runner/apply.sql
