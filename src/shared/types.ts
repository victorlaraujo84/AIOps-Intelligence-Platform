export type Role = 'super_admin' | 'tenant_admin' | 'tenant_operator' | 'tenant_viewer';

export type HonestState =
  | 'NOT_CONFIGURED'
  | 'NO_DATA'
  | 'SOURCE_STALE'
  | 'INSUFFICIENT_DATA'
  | 'MODEL_NOT_VALIDATED'
  | 'PREDICTION_UNAVAILABLE';

export type RcaCategory =
  | 'eletrica'
  | 'climatica_direta'
  | 'composta'
  | 'telecom_outros'
  | 'desconhecida';

export type ConnectorType =
  | 'open_meteo'
  | 'inmet'
  | 'cemaden'
  | 'zabbix'
  | 'prtg'
  | 'snmp_trap'
  | 'energy_ups'
  | 'webhook_csv';

export type AiAgentMode = 'offline' | 'openai' | 'ollama';

export type Criticality = 'critica' | 'alta' | 'media' | 'baixa';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  document: string | null;
  status: 'active' | 'suspended';
  created_at_utc: string;
  updated_at_utc: string;
}

export interface AuthUser {
  id: string;
  tenant_id: string | null;
  active_tenant_id: string | null;
  email: string;
  full_name: string;
  role: Role;
  is_active: boolean;
  created_at_utc: string;
  last_login_utc: string | null;
}

export interface Concession {
  id: string;
  tenant_id: string;
  name: string;
  code: string;
  region: string | null;
  description: string | null;
  created_at_utc: string;
}

export interface LocalityType {
  id: string;
  tenant_id: string;
  code: string;
  label: string;
  description: string | null;
  created_at_utc: string;
}

export interface Site {
  id: string;
  tenant_id: string;
  concession_id: string | null;
  concession_name?: string | null;
  locality_type_id: string | null;
  locality_type_code?: string | null;
  locality_type_label?: string | null;
  code: string;
  name: string;
  address: string | null;
  cep: string | null;
  municipality: string | null;
  uf: string | null;
  latitude: number | null;
  longitude: number | null;
  coord_precision: 'manual_verificada' | 'geocodificada' | 'pendente';
  coord_verified: boolean;
  criticality: Criticality;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface AssetCategory {
  id: string;
  tenant_id: string;
  code: string;
  label: string;
  domain: 'rede' | 'energia' | 'infra' | 'sensor';
  created_at_utc: string;
}

export interface Asset {
  id: string;
  tenant_id: string;
  site_id: string;
  site_name?: string;
  site_code?: string;
  category_id: string | null;
  category_code?: string | null;
  category_label?: string | null;
  name: string;
  hostname: string | null;
  ip_address: string | null;
  vendor: string | null;
  model: string | null;
  provider_name: string | null;
  redundancy_group: string | null;
  topology_parent_id: string | null;
  criticality: Criticality;
  operational_state: 'NO_DATA' | 'UP' | 'DEGRADED' | 'DOWN' | 'MAINTENANCE';
  created_at_utc: string;
  updated_at_utc: string;
}

export interface TopologyEdge {
  id: string;
  tenant_id: string;
  source_asset_id: string;
  target_asset_id: string;
  source_asset_name?: string;
  target_asset_name?: string;
  source_site_id?: string;
  target_site_id?: string;
  link_type: string;
  provider_name: string | null;
  capacity_mbps: number | null;
  is_redundant: boolean;
  created_at_utc: string;
}

export interface Connector {
  id: string;
  tenant_id: string;
  connector_type: ConnectorType;
  name: string;
  endpoint_url: string | null;
  auth_mode: 'none' | 'api_key' | 'bearer' | 'basic';
  has_credentials: boolean;
  config_json: Record<string, unknown>;
  poll_interval_sec: number;
  status: 'NOT_CONFIGURED' | 'CONFIGURED' | 'HEALTHY' | 'ERROR' | 'SOURCE_STALE';
  last_sync_at_utc: string | null;
  last_error: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface ConnectorSyncRun {
  id: string;
  tenant_id: string;
  connector_id: string;
  connector_name?: string;
  started_at_utc: string;
  finished_at_utc: string | null;
  status: 'RUNNING' | 'SUCCESS' | 'PARTIAL' | 'ERROR';
  records_ingested: number;
  records_deduplicated: number;
  latency_ms: number | null;
  error_message: string | null;
}

export interface CanonicalEvent {
  id: string;
  tenant_id: string;
  site_id: string | null;
  site_code?: string | null;
  asset_id: string | null;
  asset_name?: string | null;
  connector_id: string | null;
  idempotency_key: string;
  event_time_utc: string;
  observed_at_utc: string;
  ingested_at_utc: string;
  forecast_issued_at_utc: string | null;
  source: string;
  event_type: string;
  status: string;
  lat: number | null;
  lon: number | null;
  quality_flag: 'VALID' | 'STALE' | 'SUSPECT' | 'UNVERIFIED_COORDS';
  payload_json: Record<string, unknown>;
}

export interface Incident {
  id: string;
  tenant_id: string;
  root_site_id: string | null;
  root_site_name?: string | null;
  root_asset_id: string | null;
  root_asset_name?: string | null;
  title: string;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED';
  severity: 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAIXA';
  rca_category: RcaCategory;
  rca_confidence: number | null;
  rca_evidence: string[];
  rule_version: string;
  human_reviewed_by: string | null;
  human_reviewed_at_utc: string | null;
  opened_at_utc: string;
  resolved_at_utc: string | null;
  event_count?: number;
}

export interface AuditLog {
  id: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details_json: Record<string, unknown>;
  ip_address: string | null;
  created_at_utc: string;
}

export interface AiAgentConfig {
  tenant_id: string;
  mode: AiAgentMode;
  endpoint_url: string | null;
  has_api_key: boolean;
  model_name: string | null;
  data_sharing_authorized: boolean;
  timeout_ms: number;
  updated_by: string | null;
  updated_at_utc: string | null;
}

export interface NocOverviewResponse {
  tenant: Tenant | null;
  metrics: {
    sites_total: number;
    sites_verified_coords: number;
    sites_pending_coords: number;
    assets_total: number;
    topology_edges_total: number;
    connectors_total: number;
    connectors_healthy: number;
    connectors_error: number;
    events_24h: number;
    incidents_open: number;
  };
  honest_states: {
    telemetry_status: HonestState | 'ACTIVE';
    incidents_status: HonestState | 'ACTIVE';
    ml_status: HonestState;
    prediction_status: HonestState;
    backtest_status: HonestState;
  };
  provenance: {
    tenant_id: string;
    window: string;
    computed_at_utc: string;
    source: string;
  };
}
