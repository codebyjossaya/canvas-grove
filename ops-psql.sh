#!/usr/bin/env bash
# Tenant-scoped psql for ops/debugging. Runs as canvas_grove_app (forced row-level
# security) with app.user_id = .dev-owner, so queries can only see the developer's
# own rows, never another Grove user's sessions/quizzes. Use this instead of
# `psql -U $POSTGRES_USER` (superuser bypasses RLS). Note: `users` has no RLS.
#   ./ops-psql.sh -c "select count(*) from quizzes"   |   ./ops-psql.sh < query.sql   |   ./ops-psql.sh
set -euo pipefail
cd "$(dirname "$0")"
OWNER=$(tr -d '[:space:]' < .dev-owner 2>/dev/null || true)
[[ $OWNER =~ ^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$ ]] || { echo "ops-psql: .dev-owner missing or invalid" >&2; exit 2; }
TTY=-i; [ -t 0 ] && [ -t 1 ] && TTY=-it
exec docker exec $TTY -e PGOPTIONS="-c role=canvas_grove_app -c app.user_id=$OWNER" canvas-grove-postgres-1 \
  sh -c 'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -P pager=off "$@"' psql "$@"
