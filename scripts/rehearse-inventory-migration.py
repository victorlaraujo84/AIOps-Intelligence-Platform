#!/usr/bin/env python3
"""Gera um ensaio psql revertível a partir de um backup SQLite consistente."""

import argparse
from contextlib import closing
from datetime import datetime
import json
from pathlib import Path
import sqlite3
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

BEGIN = r"""
\set ON_ERROR_STOP on
\set VERBOSITY terse
\set SHOW_CONTEXT never
BEGIN;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';

DO $$
BEGIN
  IF current_database() <> 'aiops_inventory_rehearsal' THEN
    RAISE EXCEPTION 'Use o banco descartável aiops_inventory_rehearsal';
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

END = """
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_temp.aiops_inventory_counts WHERE source_rows <> target_rows) THEN
    RAISE EXCEPTION 'Contagem do inventário divergiu após a importação';
  END IF;
END $$;

SELECT table_name, source_rows, target_rows
FROM pg_temp.aiops_inventory_counts ORDER BY table_name;
ROLLBACK;
"""


def convert(table, row, ordinal):
    result = dict(row)
    for column, value in result.items():
        if value is None:
            continue
        try:
            if column == "id" or column.endswith("_id"):
                result[column] = str(UUID(value))
            elif column.endswith("_utc"):
                if datetime.fromisoformat(value).utcoffset() is None:
                    raise ValueError()
            elif column in {"coord_verified", "is_redundant"}:
                if value not in (0, 1):
                    raise ValueError()
                result[column] = bool(value)
            elif column == "metadata_json":
                metadata = json.loads(value)
                if not isinstance(metadata, dict):
                    raise ValueError()
                result[column] = metadata
            elif column == "uf" and len(value) != 2:
                raise ValueError()
        except (AttributeError, TypeError, ValueError):
            raise ValueError(f"{table}, linha {ordinal}, campo {column}: formato incompatível") from None

    if table == "sites" and result["coord_verified"]:
        lat, lon = result["latitude"], result["longitude"]
        if (
            not isinstance(lat, (int, float))
            or not isinstance(lon, (int, float))
            or not (-90 <= lat <= 90 and -180 <= lon <= 180)
        ):
            raise ValueError(f"sites, linha {ordinal}: coordenadas verificadas inválidas")
    return result


def write_rehearsal(db, output):
    print(BEGIN, file=output)
    for table, columns in INVENTORY.items():
        column_names = columns.split()
        names = ", ".join(column_names)
        selected = ", ".join(f"item.{column}" for column in column_names)
        print(f"""
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.{table}) THEN
    RAISE EXCEPTION 'Tabela alvo {table} precisa estar vazia';
  END IF;
END $$;
COPY pg_temp.aiops_inventory_input (document) FROM STDIN;""", file=output)

        cursor = db.execute(f"SELECT {names} FROM {table} ORDER BY id")
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
INSERT INTO pg_temp.aiops_inventory_counts
SELECT '{table}', (SELECT count(*) FROM pg_temp.aiops_inventory_input), (SELECT count(*) FROM public.{table});
TRUNCATE pg_temp.aiops_inventory_input;""", file=output)

        if table == "sites":
            print("""
UPDATE public.sites
SET geom = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)::geography
WHERE coord_verified;""", file=output)
    print(END, file=output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("snapshot", type=Path, help="backup SQLite consistente e separado da instância ativa")
    snapshot = parser.parse_args().snapshot.resolve()
    if not snapshot.is_file() or any(Path(str(snapshot) + suffix).exists() for suffix in ("-wal", "-journal")):
        parser.error("forneça um backup SQLite completo, sem arquivos WAL ou journal")
    try:
        with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
            db.row_factory = sqlite3.Row
            if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("backup SQLite falhou na verificação de integridade")
            # Prepara toda a entrada antes de tocar o PostgreSQL. O arquivo é temporário e privado.
            with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as script:
                write_rehearsal(db, script)
                script.seek(0)
                for line in script:
                    sys.stdout.write(line)
    except sqlite3.Error:
        parser.exit(1, "Falha ao ler o inventário do backup SQLite. Confira a versão do schema.\n")
    except ValueError as error:
        parser.exit(1, f"{error}.\n")


if __name__ == "__main__":
    main()
