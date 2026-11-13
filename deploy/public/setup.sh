#!/usr/bin/env bash
# Runs ON THE SERVER, inside the unpacked bundle: loads the images, creates .env with new random secrets and a new
# audit checkpoint key, then starts the stack. Prints no secret. Safe to run again: an existing .env is kept.
#   ./setup.sh <server public IP>   Caddy serves https://<IP>.sslip.io (needs inbound ports 80 and 443)
#   ./setup.sh                      no Caddy: the dashboard stays on 127.0.0.1:3000 for Tailscale Funnel (README)
set -euo pipefail
cd "$(dirname "$0")"

ip="${1:-}"

for f in images/*.tar.gz; do
  echo "• loading $f"
  gunzip -c "$f" | docker load >/dev/null
done

if [[ ! -f .env ]]; then
  umask 077
  cp .env.example .env
  rand() { openssl rand -hex 24; }
  sed -i.bak \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rand)|" \
    -e "s|^API_TOKEN=.*|API_TOKEN=$(rand)|" .env
  rm -f .env.bak
  if [[ -n "$ip" ]]; then
    sed -i.bak -e "s|^SITE_ADDRESS=.*|SITE_ADDRESS=${ip}.sslip.io|" -e "s|^COMPOSE_PROFILES=.*|COMPOSE_PROFILES=caddy|" .env
    rm -f .env.bak
    echo "• Caddy on: https://${ip}.sslip.io"
  else
    echo "• no Caddy: the dashboard will be on 127.0.0.1:3000 (expose it with Tailscale Funnel, README)"
  fi
  docker run --rm --entrypoint node near-autopilot-api:public --import tsx src/evidence/cli.ts checkpoint-keygen >>.env
  echo "• .env created (secrets generated, not shown)."
  echo "  Put the FastNEAR key into MAINNET_READ_RPC_API_KEY in .env (nano .env), then run ./setup.sh again."
  exit 0
fi

chmod 600 .env
# Keys added after the first run: an older .env gets a fresh value, never shown.
if ! grep -q '^ADMIN_API_TOKEN=.' .env; then
  sed -i.bak '/^ADMIN_API_TOKEN=/d' .env && rm -f .env.bak
  echo "ADMIN_API_TOKEN=$(openssl rand -hex 24)" >>.env
  echo "• ADMIN_API_TOKEN added to .env (not shown)"
fi
mkdir -p checkpoints
# the containers run as the unprivileged `node` user (uid 1000)
chown 1000:1000 checkpoints 2>/dev/null || chmod 777 checkpoints
docker compose up -d --remove-orphans
docker compose ps
echo "• started. First market data appears after the first collector cycle (a few minutes)."
