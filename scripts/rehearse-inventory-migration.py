#!/usr/bin/env python3
"""Ensaios de migração e carga inicial do piloto a partir de um backup SQLite consistente."""

import argparse
from contextlib import closing
from datetime import datetime
from ipaddress import ip_address
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
from uuid import UUID


INVENTORY = {
    "tenants": "id name slug document status created_at_utc updated_at_utc",
    "concessions": "id tenant_id name code region description created_at_utc",
    "locality_types": "id tenant_id code label description created_at_utc",
    "asset_categories": "id tenant_id code label domain created_at_utc",
    "sites": (
        "id tenant_id concession_id locality_type_id code name address cep municipality uf "
        "latitude longitude coord_precision coord_verified criticality created_at_utc updated_at_utc"
    ),
    "assets": (
        "id tenant_id site_id category_id asset_type_code domain georeference_mode name hostname ip_address "
        "vendor model provider_name redundancy_group topology_parent_id criticality operational_state "
        "metadata_json created_at_utc updated_at_utc"
    ),
    "services": (
        "id tenant_id code name domain criticality owner_team sla_target_pct operational_state description "
        "created_at_utc updated_at_utc"
    ),
    "service_dependencies": "id tenant_id service_id asset_id upstream_service_id dependency_role weight created_at_utc",
    "topology_edges": (
        "id tenant_id source_asset_id target_asset_id link_type provider_name capacity_mbps is_redundant created_at_utc"
    ),
}

IDENTITIES = {
    "users": "id tenant_id email full_name role password_hash is_active created_at_utc last_login_utc",
}
AUDIT = {
    "audit_logs": (
        "id tenant_id actor_user_id actor_email actor_role action resource_type resource_id "
        "details_json ip_address created_at_utc"
    ),
}
OPERATIONAL_HISTORY = {
    "connectors": (
        "id tenant_id connector_type name endpoint_url auth_mode encrypted_credentials config_json "
        "poll_interval_sec status last_sync_at_utc last_error created_at_utc updated_at_utc"
    ),
    "connector_sync_runs": (
        "id tenant_id connector_id started_at_utc finished_at_utc status records_ingested "
        "records_deduplicated latency_ms error_message raw_metadata_json"
    ),
    "canonical_events": (
        "id tenant_id site_id asset_id connector_id idempotency_key event_time_utc observed_at_utc "
        "ingested_at_utc forecast_issued_at_utc source event_type status lat lon quality_flag payload_json"
    ),
    "incidents": (
        "id tenant_id root_site_id root_asset_id title status severity impacted_services_count rca_category "
        "rca_confidence rca_evidence_json rule_version human_reviewed_by human_reviewed_at_utc opened_at_utc resolved_at_utc"
    ),
    "incident_events": "incident_id event_id tenant_id role_in_incident",
    "metric_samples": (
        "id tenant_id asset_id service_id site_id connector_id idempotency_key metric_name value_num unit "
        "observed_at_utc ingested_at_utc source quality_flag tags_json"
    ),
    "operational_logs": (
        "id tenant_id asset_id service_id site_id connector_id idempotency_key severity message "
        "observed_at_utc ingested_at_utc source trace_id attributes_json"
    ),
    "ingestion_checkpoints": (
        "id tenant_id connector_id cursor_key cursor_value rows_processed bytes_processed status updated_at_utc"
    ),
    "authorized_collection_scopes": (
        "id tenant_id protocol target_cidr_or_host port description rate_limit_rpm is_active approved_by approved_at_utc"
    ),
    "anomaly_detections": (
        "id tenant_id asset_id service_id metric_name observed_value baseline_mean baseline_stddev z_score "
        "severity detected_at_utc status"
    ),
    "ai_agent_configs": (
        "tenant_id mode endpoint_url encrypted_api_key model_name data_sharing_authorized timeout_ms updated_by updated_at_utc"
    ),
}
TABLE_KEYS = {
    "ai_agent_configs": ("tenant_id",),
    "incident_events": ("incident_id", "event_id"),
    "metric_samples": ("tenant_id", "observed_at_utc", "id"),
}
REHEARSAL_DATABASE = "aiops_inventory_rehearsal"
PILOT_DATABASE = "aiops_inventory_pilot"
RELEASE_DATABASE = "aiops_platform_postgres"
SCRYPT_HASH = re.compile(r"scrypt:[0-9a-f]{32}:[0-9a-f]{128}")

BEGIN = r"""
\set ON_ERROR_STOP on
\set VERBOSITY terse
\set SHOW_CONTEXT never
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL log_error_verbosity = 'terse';
SET LOCAL log_min_error_statement = 'panic';

DO $$
BEGIN
  IF current_database() <> '{database}' THEN
    RAISE EXCEPTION 'Use o banco dedicado {database}';
  END IF;
  PERFORM pg_advisory_xact_lock(189174310, 1);
  IF to_regclass('aiops_admin.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Aplique as migrações PostgreSQL antes do ensaio';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM aiops_admin.schema_migrations WHERE version = 5) THEN
    RAISE EXCEPTION 'O ensaio exige a migração PostgreSQL 005';
  END IF;
END $$;


CREATE TEMP TABLE aiops_inventory_input (document jsonb NOT NULL) ON COMMIT DROP;
CREATE TEMP TABLE aiops_inventory_counts (
  table_name text NOT NULL,
  source_rows bigint NOT NULL,
  target_rows bigint NOT NULL
) ON COMMIT DROP;
"""

IDENTITY_GUARD = """
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM aiops_admin.schema_migrations WHERE version = 6) THEN
    RAISE EXCEPTION 'O ensaio de identidades exige a migração PostgreSQL 006';
  END IF;
END $$;
"""

PILOT_GUARD = """
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM aiops_admin.schema_migrations WHERE version = 18) THEN
    RAISE EXCEPTION 'A carga do piloto exige a migração PostgreSQL 018';
  END IF;
END $$;
"""

VERIFY_NO_SESSIONS = """
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sessions) THEN
    RAISE EXCEPTION 'O banco de ensaio deve estar sem sessões';
  END IF;
END $$;
"""

END = """
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.aiops_inventory_counts WHERE source_rows <> target_rows) THEN
    RAISE EXCEPTION 'Contagem do inventário divergiu após a importação';
  END IF;
END $$;

SELECT table_name, source_rows, target_rows
FROM pg_temp.aiops_inventory_counts ORDER BY table_name;
"""


def convert(table, row, ordinal):
    result = dict(row)
    for column, value in result.items():
        if value is None:
            continue
        try:
            if column == "id" or (column.endswith("_id") and column != "resource_id"):
                result[column] = str(UUID(value))
            elif column.endswith("_utc"):
                if datetime.fromisoformat(value).utcoffset() is None:
                    raise ValueError()
            elif column in {"coord_verified", "is_redundant", "is_active", "data_sharing_authorized"}:
                if value not in (0, 1):
                    raise ValueError()
                result[column] = bool(value)
            elif column.endswith("_json"):
                document = json.loads(value)
                expected_type = list if column == "rca_evidence_json" else dict
                if not isinstance(document, expected_type):
                    raise ValueError()
                result[column] = document
            elif table == "audit_logs" and column == "ip_address":
                result[column] = None if value == "unknown" else str(ip_address(value))
            elif column == "uf" and len(value) != 2:
                raise ValueError()
        except (AttributeError, TypeError, ValueError):
            raise ValueError(f"{table}, linha {ordinal}, campo {column}: formato incompatível") from None

    if table == "users":
        password_hash = result["password_hash"]
        if not isinstance(password_hash, str) or not SCRYPT_HASH.fullmatch(password_hash):
            raise ValueError(f"users, linha {ordinal}: hash de senha incompatível")
        if (result["role"] == "super_admin") != (result["tenant_id"] is None):
            raise ValueError(f"users, linha {ordinal}: papel incompatível com o vínculo de tenant")
    if table == "sites" and result["coord_verified"]:
        lat, lon = result["latitude"], result["longitude"]
        if (
            not isinstance(lat, (int, float))
            or not isinstance(lon, (int, float))
            or not (-90 <= lat <= 90 and -180 <= lon <= 180)
        ):
            raise ValueError(f"sites, linha {ordinal}: coordenadas verificadas inválidas")
    return result


def write_transfer(db, output, *, include_identities=False, database=REHEARSAL_DATABASE):
    print(BEGIN.format(database=database), file=output)
    if database != REHEARSAL_DATABASE:
        print(PILOT_GUARD, file=output)
    tables = INVENTORY
    if include_identities:
        print(IDENTITY_GUARD, file=output)
        print(VERIFY_NO_SESSIONS, file=output)
        tables = INVENTORY | IDENTITIES | AUDIT
    if database == RELEASE_DATABASE:
        tables = tables | OPERATIONAL_HISTORY
        known = set(tables) | {"schema_migrations", "sessions"}
        source_tables = {row[0] for row in db.execute(
            "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'"
        )}
        if source_tables - known:
            raise ValueError("O backup contém tabelas fora do contrato de migração")
    for table, columns in tables.items():
        key = TABLE_KEYS.get(table, ("id",))
        join_key = " AND ".join(f"actual.{column} = item.{column}" for column in key)
        order_key = ", ".join(key)
        column_names = columns.split()
        names = ", ".join(column_names)
        selected = ", ".join(f"item.{column}" for column in column_names)
        actual = ", ".join(f"actual.{column}" for column in column_names)
        print(f"""
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.{table}) THEN
    RAISE EXCEPTION 'Tabela alvo {table} precisa estar vazia';
  END IF;
END $$;
COPY pg_temp.aiops_inventory_input (document) FROM STDIN;""", file=output)

        cursor = db.execute(f"SELECT {names} FROM {table} ORDER BY {order_key}")
        for ordinal, row in enumerate(cursor, 1):
            record = convert(table, row, ordinal)
            try:
                document = json.dumps(record, ensure_ascii=True, allow_nan=False)
            except ValueError:
                raise ValueError(f"{table}, linha {ordinal}: valor JSON inválido") from None
            print(document.replace("\\", "\\\\"), file=output)
        print(r"\.", file=output)

        print(f"""
INSERT INTO public.{table} ({names})
SELECT {selected} FROM pg_temp.aiops_inventory_input AS source
CROSS JOIN LATERAL jsonb_populate_record(NULL::public.{table}, source.document) AS item;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_temp.aiops_inventory_input AS source
    CROSS JOIN LATERAL jsonb_populate_record(NULL::public.{table}, source.document) AS item
    LEFT JOIN public.{table} AS actual ON {join_key}
    WHERE actual.{key[0]} IS NULL OR ROW({actual}) IS DISTINCT FROM ROW({selected})
  ) THEN
    RAISE EXCEPTION 'Campos em {table} divergem da origem';
  END IF;
END $$;

INSERT INTO pg_temp.aiops_inventory_counts
SELECT '{table}', (SELECT count(*) FROM pg_temp.aiops_inventory_input), (SELECT count(*) FROM public.{table});""", file=output)

        print("TRUNCATE pg_temp.aiops_inventory_input;", file=output)

        if table == "sites":
            print("""
UPDATE public.sites
SET geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
WHERE coord_verified;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.sites
    WHERE (NOT coord_verified AND geom IS NOT NULL)
       OR (coord_verified AND (
         geom IS NULL OR ST_SRID(geom::geometry) <> 4326
         OR ST_X(geom::geometry) IS DISTINCT FROM longitude
         OR ST_Y(geom::geometry) IS DISTINCT FROM latitude
       ))
  ) THEN
    RAISE EXCEPTION 'Geometria dos sites diverge das coordenadas verificadas';
  END IF;
END $$;""", file=output)
    if include_identities:
        print(VERIFY_NO_SESSIONS, file=output)
    print(END, file=output)
    print("ROLLBACK;" if database == REHEARSAL_DATABASE else "COMMIT;", file=output)


def run_compose_transfer(db, project, env_file, *, include_identities, database):
    command = ["docker", "compose", "--project-name", project, "--profile", "core"]
    if env_file is not None:
        command.extend(["--env-file", str(env_file)])
    if database == RELEASE_DATABASE:
        command.extend(["-f", "compose.yaml", "-f", "compose.postgres-release.yaml"])
    command.extend([
        "exec", "-T", "postgres", "sh", "-ec",
        'exec psql -XqAt -F "|" -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1" -f -',
        "psql", database,
    ])

    # O SQL sensível segue direto para o cliente, sem spool e sem eco. Descartamos
    # diagnósticos do psql, que podem incluir valores da operação COPY.
    with subprocess.Popen(
        command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8",
    ) as process:
        try:
            with process.stdin:
                write_transfer(db, process.stdin, include_identities=include_identities, database=database)
        except BrokenPipeError:
            raise ValueError("o PostgreSQL encerrou a operação; confira o projeto, o schema e o banco vazio") from None
        rows = process.stdout.read().splitlines()
        if process.wait() != 0:
            raise ValueError("o PostgreSQL recusou a operação; confira o projeto, o banco vazio, os vínculos e as migrações")

    expected = set(INVENTORY)
    if include_identities:
        expected.update(IDENTITIES)
        expected.update(AUDIT)
    if database == RELEASE_DATABASE:
        expected.update(OPERATIONAL_HISTORY)
    for row in rows:
        match = re.fullmatch(r"([a-z_]+)\|([0-9]+)\|([0-9]+)", row)
        if not match or match[1] not in expected or match[2] != match[3]:
            raise ValueError("resposta inesperada no relatório de contagens")
        expected.remove(match[1])
    if expected:
        raise ValueError("relatório de contagens incompleto")
    print("\n".join(rows))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, help="backup SQLite consistente e separado da instância ativa")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--identity-project", help="inclui usuários e auditoria via psql no projeto Compose descartável")
    mode.add_argument("--inventory-project", help="envia apenas o inventário ao projeto Compose descartável")
    mode.add_argument(
        "--pilot-project", help="persiste inventário, identidades e auditoria no banco vazio aiops_inventory_pilot",
    )
    mode.add_argument(
        "--release-project", help="carrega uma instalação vazia do Compose PostgreSQL",
    )
    parser.add_argument("--env-file", type=Path, help="arquivo de variáveis do projeto Compose")
    args = parser.parse_args()
    database = RELEASE_DATABASE if args.release_project else PILOT_DATABASE if args.pilot_project else REHEARSAL_DATABASE
    project = next((name for name in (args.release_project, args.pilot_project, args.identity_project, args.inventory_project)
                    if name is not None), None)
    if project is not None and not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", project):
        parser.error("nome de projeto Compose inválido")
    if args.release_project and args.env_file is None:
        parser.error("--release-project exige --env-file")
    if args.env_file is not None and project is None:
        parser.error("--env-file exige um projeto Compose")
    snapshot = args.snapshot.resolve()
    if not snapshot.is_file() or any(Path(str(snapshot) + suffix).exists() for suffix in ("-wal", "-journal")):
        parser.error("forneça um backup SQLite completo, sem arquivos WAL ou journal")
    try:
        with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            db.row_factory = sqlite3.Row
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("backup SQLite falhou na verificação de integridade")
            if project is not None:
                run_compose_transfer(
                    db, project, args.env_file,
                    include_identities=database != REHEARSAL_DATABASE or args.identity_project is not None, database=database,
                )
                return
            # Prepara toda a entrada antes de tocar o PostgreSQL. O arquivo é temporário e privado.
            with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as script:
                write_transfer(db, script)
                script.seek(0)
                for line in script:
                    sys.stdout.write(line)
    except sqlite3.Error:
        parser.exit(1, "Falha ao ler o backup SQLite. Confira a versão do schema.\n")
    except OSError:
        parser.exit(1, "Falha de entrada ou saída. Confira o backup, o Docker e o projeto Compose.\n")
    except ValueError as error:
        parser.exit(1, f"{error}.\n")


if __name__ == "__main__":
    main()
