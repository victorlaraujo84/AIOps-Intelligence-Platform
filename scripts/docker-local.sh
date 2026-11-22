#!/bin/sh
set -eu
umask 077
cd "$(dirname "$0")/.."
state=.aiops-local
project=aiops-local-pg
env_file=$state/release.env
export AIOPS_WEBHOOK_CONFIG_DIR=./.aiops-local/destinations
export AIOPS_PROXY_SUBNET=${AIOPS_PROXY_SUBNET:-172.31.242.0/24}
export AIOPS_PROXY_IP=${AIOPS_PROXY_IP:-172.31.242.254}
provision() {
  python3 scripts/provision-postgres-release.py --env-file "$env_file" --project "$project" "$@"
}
dc() {
  docker compose --env-file "$env_file" -p "$project" \
    -f compose.yaml -f compose.postgres-release.yaml -f compose.postgres-weather.yaml \
    -f compose.postgres-notifications.yaml -f compose.postgres-local.yaml \
    --profile core --profile weather --profile notifications "$@"
}
case "${1:-}" in
  install)
    mkdir -p "$state/backups" "$state/destinations"
    if [ ! -f "$env_file" ]; then
      if docker volume inspect "${project}_pgdata" >/dev/null 2>&1; then
        echo "O volume PostgreSQL já existe. Restaure $env_file antes de continuar." >&2
        exit 1
      fi
      provision prepare --local
    fi
    dc config --quiet
    dc up -d --no-build --wait postgres
    dc run --rm --no-deps postgres-migrate
    provision roles
    dc up -d --no-build --wait
    dc cp proxy:/data/caddy/pki/authorities/local/root.crt "$state/root-ca.crt"
    printf 'Console disponível em https://localhost:%s/postgres-inventory\n' "${AIOPS_LOCAL_PORT:-8443}"
    ;;
  admin) shift; provision bootstrap "$@" ;;
  compose) shift; dc "$@" ;;
  *) echo 'Uso: docker-local.sh install | admin --email EMAIL --name NOME | compose ARGS' >&2; exit 2 ;;
esac
