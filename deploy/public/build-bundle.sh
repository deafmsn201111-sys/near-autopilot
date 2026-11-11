#!/usr/bin/env bash
# Runs on the DEVELOPER machine: builds the API and dashboard images for the server's platform and packs them with
# this folder into one archive to copy to the server. No .env, key or database goes into it (.dockerignore excludes
# .env; the script checks the images for it).
#   deploy/public/build-bundle.sh [linux/amd64|linux/arm64]
set -euo pipefail
platform="${1:-linux/amd64}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
sha="$(git -C "$root" rev-parse --short HEAD)"
out="$root/deploy/public/dist/near-autopilot-public-$sha"
rm -rf "$out" && mkdir -p "$out/images" "$out/config"

docker buildx build --platform "$platform" -f "$root/docker/api.Dockerfile" -t near-autopilot-api:public --load "$root"
docker buildx build --platform "$platform" -f "$root/docker/analytics.Dockerfile" -t near-autopilot-analytics:public --load "$root"

# No .env, key or checkpoint file in the application folders of the images (system CA bundles are not keys).
for img in near-autopilot-api:public near-autopilot-analytics:public; do
  found="$(docker run --rm --platform "$platform" --entrypoint sh "$img" -c \
    'find /repo /home -xdev \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" -o -name "id_*" -o -name "checkpoints.jsonl" \) ! -name ".env.example" 2>/dev/null')"
  if [[ -n "$found" ]]; then
    echo "refusing: $img contains:" >&2
    echo "$found" >&2
    exit 1
  fi
done

docker save near-autopilot-api:public | gzip >"$out/images/api.tar.gz"
docker save near-autopilot-analytics:public | gzip >"$out/images/analytics.tar.gz"
cp "$root/deploy/public/"{docker-compose.yml,Caddyfile,.env.example,setup.sh,README.md} "$out/"
cp "$root/config/market.json" "$out/config/market.json"
echo "$sha $platform" >"$out/VERSION"
tar -C "$(dirname "$out")" -czf "$out.tar.gz" "$(basename "$out")"
rm -rf "$out"
echo "bundle: $out.tar.gz ($(du -h "$out.tar.gz" | cut -f1))"
