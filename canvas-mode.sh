#!/usr/bin/env bash
# Switch canvas-grove between dev (hot reload) and prod (built Docker images).
#   ./canvas-mode.sh          show the current mode
#   ./canvas-mode.sh prod     build images from the current source and run them
#   ./canvas-mode.sh dev      back to bind-mounted hot reload
# Data (Postgres volume, Tailscale node, URL) is shared by both modes.
set -euo pipefail
cd "$(dirname "$0")"
current=$(cat .canvas-mode 2>/dev/null || echo dev)
target=${1:-}
if [ -z "$target" ]; then echo "mode: $current"; exit 0; fi
case "$target" in dev|prod) ;; *) echo "usage: $0 [dev|prod]" >&2; exit 2;; esac
echo "$target" > .canvas-mode
if [ "$target" = prod ]; then
  ./homelab-compose.sh build
else
  ./homelab-compose.sh build app sync-worker migrate
fi
# Recreate every app container in the new mode's config, but never the Tailscale
# sidecar: it holds the tailnet login, and the URL doesn't depend on the mode.
mapfile -t app_services < <(./homelab-compose.sh config --services | grep -vx tailscale)
./homelab-compose.sh up -d --force-recreate --remove-orphans --no-deps "${app_services[@]}"
./homelab-compose.sh up -d --no-recreate tailscale
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 30 http://127.0.0.1:${LAN_PORT:-3000}/ || true)
  [ "$code" = 200 ] && { echo "canvas-grove is up in $target mode"; exit 0; }
  sleep 5
done
echo "canvas-grove did not answer 200 after switching to $target. Check: ./homelab-compose.sh ps" >&2
exit 1
