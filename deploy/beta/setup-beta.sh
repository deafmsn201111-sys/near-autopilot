#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  umask 077
  cp .env.example .env
  rand() { openssl rand -hex 24; }
  sed -i.bak \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" \
    -e "s|^API_TOKEN=.*|API_TOKEN=$(rand)|" .env
  rm -f .env.bak
  docker run --rm --entrypoint node near-autopilot-api:beta --import tsx src/evidence/cli.ts checkpoint-keygen >>.env
fi

chmod 600 .env
mkdir -p checkpoints
chown 1000:1000 checkpoints 2>/dev/null || chmod 777 checkpoints
docker network inspect near-autopilot-beta-edge >/dev/null 2>&1 || docker network create near-autopilot-beta-edge >/dev/null
docker compose -p near-autopilot-beta up -d --remove-orphans
