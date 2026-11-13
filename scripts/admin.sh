#!/usr/bin/env bash
# Opens the server's admin through an SSH tunnel and in the browser. Ctrl+C closes the tunnel.
# Usage: ./scripts/admin.sh [ssh-host]   (default: near-autopilot, an entry in ~/.ssh/config)
set -euo pipefail
host="${1:-near-autopilot}"
port="${ADMIN_LOCAL_PORT:-3012}"
url="http://127.0.0.1:$port/admin"

ssh -N -o ExitOnForwardFailure=yes -L "$port:127.0.0.1:3003" "$host" &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT INT TERM

for _ in $(seq 75); do
  kill -0 "$pid" 2>/dev/null || { echo "SSH tunnel to $host failed (see above)" >&2; exit 1; }
  curl -s -o /dev/null "$url" && break
  sleep 0.2
done

echo "Admin: $url   (Ctrl+C closes the tunnel)"
open "$url" 2>/dev/null || xdg-open "$url" 2>/dev/null || true
wait "$pid"
