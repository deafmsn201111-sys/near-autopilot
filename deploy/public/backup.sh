#!/bin/sh
# Installed as /opt/near-autopilot/backup.sh and run nightly by near-autopilot-backup.timer (see README.md).
set -eu

dir=/opt/near-autopilot/backups
mkdir -p "$dir"
chmod 700 "$dir"

postgres=$(docker ps -q \
  --filter label=com.docker.compose.project=near-autopilot-public \
  --filter label=com.docker.compose.service=postgres)
[ -n "$postgres" ] || { echo "postgres container not running" >&2; exit 1; }

docker exec "$postgres" pg_dump -U autopilot -Fc autopilot > "$dir/partial.dump"
mv "$dir/partial.dump" "$dir/$(date +%F).dump"

ls -1t "$dir"/*.dump | tail -n +8 | xargs -r rm --
