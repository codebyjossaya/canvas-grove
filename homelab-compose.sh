#!/usr/bin/env bash
# docker compose for canvas-grove on jc-homelab, in the current mode.
# The mode lives in .canvas-mode ("dev" or "prod"); change it with ./canvas-mode.sh.
#   dev : compose.yaml + compose.homelab.yaml + compose.dev.yaml (bind mounts, hot reload)
#   prod: compose.yaml + compose.homelab.yaml                    (built images, no mounts)
# Usage: ./homelab-compose.sh ps | logs -f app | restart sync-worker | ...
cd "$(dirname "$0")"
mode=$(cat .canvas-mode 2>/dev/null || echo dev)
files=(-f compose.yaml -f compose.homelab.yaml)
[ "$mode" = dev ] && files+=(-f compose.dev.yaml)
exec docker compose -p canvas-grove --env-file .env.docker "${files[@]}" "$@"
