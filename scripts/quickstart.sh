#!/usr/bin/env bash
# NEAR Autopilot - one command from a fresh clone to running dashboards. Needs Docker (Compose v2) only.
#
#   ./scripts/quickstart.sh             simulation autopilot + mainnet READ-ONLY analytics (no key, no wallet)
#   ./scripts/quickstart.sh --offline   simulation only: nothing leaves this machine
#
# What it does, and does not:
#   - creates .env from .env.example ONLY if .env does not exist, with fresh random secrets (never printed), the
#     simulation data source and the orchestrator engine; an existing .env is never touched
#   - creates config/autopilot.json from the testnet example ONLY if it does not exist
#   - builds and starts the containers (bound to 127.0.0.1), waits until they are healthy, runs one dry-run cycle
#   - never creates a key, never signs, never sends a transaction; mainnet is read with view calls only
set -euo pipefail
cd "$(dirname "$0")/.."

OFFLINE=0
for arg in "$@"; do
  case "$arg" in
    --offline) OFFLINE=1 ;;
    -h | --help)
      sed -n '2,13p' "$0"
      exit 0
      ;;
    *)
      echo "unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

command -v docker >/dev/null || { echo "Docker is required: https://docs.docker.com/get-docker/" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is required (docker compose ...)" >&2; exit 1; }

rand() { # hex secret of $1 bytes, without echoing it anywhere
  if command -v openssl >/dev/null; then openssl rand -hex "$1"; else od -An -tx1 -N"$1" /dev/urandom | tr -d ' \n'; fi
}
set_var() { # set_var KEY VALUE in .env (value is a hex/plain token: no sed metacharacters)
  if grep -q "^$1=" .env; then
    sed -i.bak "s|^$1=.*|$1=$2|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}

if [ -f .env ]; then
  echo "• .env exists: using it as it is"
else
  cp .env.example .env
  pw="$(rand 24)"
  set_var API_TOKEN "$(rand 32)"
  set_var POSTGRES_PASSWORD "$pw"
  set_var DATABASE_URL "postgres://autopilot:${pw}@localhost:5432/autopilot"
  set_var DATA_SOURCE simulation
  set_var AUTOPILOT_ENGINE orchestrator
  set_var AUTOPILOT_ACCOUNT_ID demo-autopilot.testnet
  chmod 600 .env
  echo "• .env created with fresh secrets (not shown), simulation mode, dry-run"
fi

if [ -f config/autopilot.json ]; then
  echo "• config/autopilot.json exists: using it as it is"
else
  account="$(grep '^AUTOPILOT_ACCOUNT_ID=' .env | cut -d= -f2-)"
  sed "s|\"signerAccountId\": \"[^\"]*\"|\"signerAccountId\": \"${account}\"|" config/autopilot.testnet.example.json \
    >config/autopilot.json
  echo "• config/autopilot.json created from the testnet example (signer ${account}, never used to sign)"
fi

profiles=()
[ "$OFFLINE" = 1 ] || profiles=(--profile shadow)
profile_text="$([ "$OFFLINE" = 1 ] || echo "--profile shadow ")"
echo "• building and starting containers (first run: a few minutes)…"
docker compose ${profiles[@]+"${profiles[@]}"} up -d --build

echo "• waiting for the services to be healthy…"
deadline=$((SECONDS + 600))
while true; do
  states="$(docker compose ${profiles[@]+"${profiles[@]}"} ps --format '{{.Service}} {{.Health}}')"
  if ! grep -qv ' healthy$' <<<"$states"; then break; fi
  if [ $SECONDS -gt $deadline ]; then
    echo "not healthy after 10 minutes:" >&2
    grep -v ' healthy$' <<<"$states" >&2
    echo "logs: docker compose ${profile_text}logs <service>" >&2
    exit 1
  fi
  sleep 3
done

port() { grep "^$1=" .env | cut -d= -f2- || true; }
api_port="${API_HOST_PORT:-$(port API_HOST_PORT)}"
token="$(grep '^API_TOKEN=' .env | cut -d= -f2-)"
echo "• running one dry-run cycle on the simulated demo portfolio…"
curl -fsS -o /dev/null -X POST -H "Authorization: Bearer ${token}" "http://127.0.0.1:${api_port:-4000}/v1/runs" &&
  echo "  done (a policy verdict, a gateway record and audit entries now exist)" ||
  echo "  the cycle request failed; see: docker compose logs api" >&2

dash="${DASHBOARD_PORT:-$(port DASHBOARD_PORT)}"
echo
echo "Ready. Everything is bound to 127.0.0.1; nothing is signed or sent."
echo "  Autopilot dashboard (simulation)   http://127.0.0.1:${dash:-3004}"
if [ "$OFFLINE" = 0 ]; then
  ana="${ANALYTICS_DASHBOARD_PORT:-$(port ANALYTICS_DASHBOARD_PORT)}"
  sh_dash="${SHADOW_DASHBOARD_PORT:-$(port SHADOW_DASHBOARD_PORT)}"
  echo "  Analytics: policy, routes, audit, thesis, markets   http://127.0.0.1:${ana:-3001}"
  echo "  Shadow autopilot on mainnet data   http://127.0.0.1:${sh_dash:-3003}"
  echo "  (the mainnet collector fills the market pages within its first cycle, ~1-2 minutes)"
fi
echo "Stop: docker compose ${profile_text}stop   (data is kept)"
