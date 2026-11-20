#!/bin/sh
set -eu

if [ -e .env ] || [ -L .env ]; then
  printf '%s\n' 'O arquivo .env já existe. Preserve os valores atuais e consulte docs/deployment.md.' >&2
  exit 1
fi

session_secret=$(openssl rand -hex 32)
encryption_key=$(openssl rand -hex 32)
bootstrap_token=$(openssl rand -hex 32)
postgres_password=$(openssl rand -hex 32)

umask 077
set -C
cat > .env <<VALUES
AUTH_SESSION_SECRET=$session_secret
CREDENTIAL_ENCRYPTION_KEY=$encryption_key
AIOPS_BOOTSTRAP_TOKEN=$bootstrap_token
POSTGRES_PASSWORD=$postgres_password
AIOPS_HOST=localhost
AIOPS_BIND_IP=127.0.0.1
VALUES

printf '%s\n' 'Arquivo .env criado com permissões restritas.'
