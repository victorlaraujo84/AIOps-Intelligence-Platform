#!/bin/sh
set -eu
umask 077
cd "${STATE_DIR:-/state}"
sample() {
  free=$(df -Pk . | awk 'END{print $4}')
  measured=$(psql -XAtq -v ON_ERROR_STOP=1 -c "select pg_database_size(current_database())||' '||(select sum(size) from pg_ls_waldir())") || return 1
  printf '%s %s %s\n' "$(date -u +%FT%TZ)" "$free" "$measured" >> "capacity-$(date -u +%F).log"
  find . -name 'capacity-*.log' -mtime +6 -delete
  if [ "$free" -le "${LOW_KIB:-262144}" ]; then
    echo "ALERTA disco livre: $free KiB" >&2
    return 1
  fi
}
if [ "${1:-}" = sample ]; then sample; exit; fi
while :; do
  if (set -e; sample); then
    touch capacity-ok
  else
    rm -f capacity-ok
  fi
  hour=$(date -u +%Y%m%dT%H)
  if [ -f capacity-ok ] && [ ! -s "$hour.dump" ]; then
    if pg_dump -Fc --lock-wait-timeout=10s -f pending.tmp && pg_restore -l pending.tmp >/dev/null; then
      mv pending.tmp "$hour.dump"
      touch backup-ok
      ls -1t [0-9]*T[0-9][0-9].dump 2>/dev/null | tail -n +8 | while read -r old; do rm -f "./$old"; done
    else
      echo 'ALERTA falha no backup PostgreSQL' >&2
      rm -f backup-ok pending.tmp
    fi
  fi
  sleep 300
done
