#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rand() { openssl rand -hex 24; }

if [[ ! -f .env ]]; then
  umask 077
  cp .env.example .env
  sed -i.bak \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" \
    -e "s|^API_TOKEN=.*|API_TOKEN=$(rand)|" .env
  docker run --rm --entrypoint node near-autopilot-api:beta --import tsx src/evidence/cli.ts checkpoint-keygen >>.env
fi

# Older beta installs predate the loopback-only admin service.
admin_token=$(sed -n 's/^ADMIN_API_TOKEN=//p' .env)
api_token=$(sed -n 's/^API_TOKEN=//p' .env)
if [[ ${#admin_token} -lt 32 || "$admin_token" == "$api_token" ]]; then
  if grep -q '^ADMIN_API_TOKEN=' .env; then
    sed -i.bak -e "s|^ADMIN_API_TOKEN=.*|ADMIN_API_TOKEN=$(rand)|" .env
  else
    printf '\nADMIN_API_TOKEN=%s\n' "$(rand)" >>.env
  fi
fi
rm -f .env.bak

chmod 600 .env
mkdir -p checkpoints
chown 1000:1000 checkpoints 2>/dev/null || chmod 777 checkpoints
docker network inspect near-autopilot-beta-edge >/dev/null 2>&1 || docker network create near-autopilot-beta-edge >/dev/null
docker compose -p near-autopilot-beta up -d --remove-orphans
