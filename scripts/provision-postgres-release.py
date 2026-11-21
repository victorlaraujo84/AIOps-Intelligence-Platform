#!/usr/bin/env python3
"""Prepara um projeto Compose PostgreSQL e inicializa o administrador de uma base vazia."""

import argparse
import getpass
import hashlib
import os
from pathlib import Path
import re
import secrets
import subprocess

DATABASE = "aiops_platform_postgres"
ROLE_NAMES = {
    "AUTH": ("auth", "aiops_authenticator"),
    "INVENTORY": ("inventory", "aiops_tenant_reader"),
    "SITE_WRITE": ("site", "aiops_site_writer"),
    "ASSET_WRITE": ("asset", "aiops_asset_writer"),
    "SERVICE_WRITE": ("service", "aiops_service_writer"),
}
CHECK_DATABASE = f"""
BEGIN;
SET LOCAL log_min_error_statement = 'panic';
SET LOCAL standard_conforming_strings = on;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(189174310, 1);
DO $$ BEGIN
  IF current_database() <> '{DATABASE}' THEN RAISE EXCEPTION 'Use o banco dedicado'; END IF;
END $$;
"""


def prepare(env_file):
    fd = os.open(env_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        for key, value in {
            "POSTGRES_DB": DATABASE,
            "POSTGRES_PASSWORD": secrets.token_hex(32),
            "AIOPS_POSTGRES_AUTH_SESSION_SECRET": secrets.token_hex(32),
        }.items():
            handle.write(f"{key}={value}\n")
        for key, (suffix, _) in ROLE_NAMES.items():
            handle.write(
                f"AIOPS_POSTGRES_{key}_DSN=postgresql://aiops_release_{suffix}:{secrets.token_hex(32)}"
                f"@postgres:5432/{DATABASE}\n"
            )


def provision_roles(env_file):
    values = dict(
        line.split("=", 1) for line in env_file.read_text().splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    )
    if values.get("POSTGRES_DB") != DATABASE:
        raise ValueError("O arquivo deve selecionar o banco dedicado.")
    sql = CHECK_DATABASE
    for key, (suffix, role) in ROLE_NAMES.items():
        login = f"aiops_release_{suffix}"
        expected = rf"postgresql://{login}:([0-9a-f]{{64}})@postgres:5432/{DATABASE}"
        match = re.fullmatch(expected, values.get(f"AIOPS_POSTGRES_{key}_DSN", ""))
        if match is None:
            raise ValueError(f"DSN inválido para {key}.")
        inheritance = "INHERIT" if key == "AUTH" else "NOINHERIT"
        membership = "INHERIT TRUE" if key == "AUTH" else "INHERIT FALSE, SET TRUE"
        sql += f"""
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{login}') THEN
    CREATE ROLE {login};
  END IF;
END $$;
ALTER ROLE {login} LOGIN {inheritance} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD '{match[1]}';
GRANT {role} TO {login} WITH {membership};
"""
    return sql + "COMMIT;\n"


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def bootstrap(args):
    email = args.email.strip().lower()
    name = args.name.strip()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+", email) or len(email) > 254 or not 1 <= len(name) <= 200:
        raise ValueError("Informe e-mail e nome válidos.")
    if args.password_file:
        verify_private_file(args.password_file)
        password = args.password_file.read_text().removesuffix("\n")
    else:
        password = getpass.getpass("Senha inicial do administrador: ")
        if password != getpass.getpass("Confirme a senha: "):
            raise ValueError("As senhas divergem.")
    if not 12 <= len(password) <= 1024 or "\0" in email + name + password:
        raise ValueError("A senha deve ter entre 12 e 1024 caracteres e os campos devem ser válidos.")
    salt = secrets.token_hex(16)
    key = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=64)
    hashed = "scrypt:" + salt + ":" + key.hex()
    return CHECK_DATABASE + f"""
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.users) THEN RAISE EXCEPTION 'Banco já inicializado'; END IF;
END $$;
WITH created AS (
  INSERT INTO public.users (email, full_name, role, password_hash)
  VALUES ({literal(email)}, {literal(name)}, 'super_admin', {literal(hashed)})
  RETURNING id
)
INSERT INTO public.audit_logs (actor_user_id, actor_role, action, resource_type, resource_id)
SELECT id, 'super_admin', 'BOOTSTRAP_COMPLETED', 'user', id::text FROM created;
COMMIT;
"""


def verify_private_file(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise ValueError("Use um arquivo regular com permissões restritas.")


def psql(args, sql):
    command = [
        "docker", "compose", "--env-file", str(args.env_file),
        "-f", "compose.yaml", "-f", "compose.postgres-release.yaml",
        "--profile", "core", "-p", args.project, "exec", "-T", "postgres", "sh", "-ec",
        'exec psql -Xq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -',
    ]
    result = subprocess.run(command, input=sql, text=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode:
        raise ValueError("O PostgreSQL recusou a operação. Confira o projeto, as migrações e se a base já foi inicializada.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--project", default="aiops-postgres")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("prepare")
    actions.add_parser("roles")
    account = actions.add_parser("bootstrap")
    account.add_argument("--email", required=True)
    account.add_argument("--name", required=True)
    account.add_argument("--password-file", type=Path)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", args.project):
        parser.error("Nome de projeto inválido.")
    try:
        if args.action == "prepare":
            prepare(args.env_file)
        else:
            verify_private_file(args.env_file)
            sql = provision_roles(args.env_file) if args.action == "roles" else bootstrap(args)
            psql(args, sql)
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")
    print("Operação concluída.")


if __name__ == "__main__":
    main()
