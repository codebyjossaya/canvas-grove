#!/usr/bin/env bash
# Runs DB integration tests against a DISPOSABLE database (canvas_grove_test) inside
# canvas-grove-postgres-1. The real database is never touched: the test DB is dropped and
# recreated on every run, and the test's cluster-level qa_app role is removed afterwards.
# Usage: scripts/run-integration-tests.sh        (run on the host that owns the containers)
# tests/mirror-live.integration.test.mjs is NOT run here; see REMAINING_TASKS.md.
set -euo pipefail
PG=${PG_CONTAINER:-canvas-grove-postgres-1}
APP=${APP_CONTAINER:-canvas-grove-app-1}
TESTDB=canvas_grove_test
PGU=$(docker exec "$PG" printenv POSTGRES_USER)
PGPW=$(docker exec "$PG" printenv POSTGRES_PASSWORD)
psqladmin() { docker exec "$PG" psql -v ON_ERROR_STOP=1 -U "$PGU" -d postgres -q -c "$1"; }
cleanup() { psqladmin "drop database if exists $TESTDB with (force)" >/dev/null; psqladmin "drop role if exists qa_app" >/dev/null || true; }
trap cleanup EXIT
cleanup
psqladmin "create database $TESTDB"
docker exec -e U="$PGU" -e P="$PGPW" -e TESTDB="$TESTDB" "$APP" sh -c \
  'TEST_DATABASE_URL="postgres://$U:$P@postgres:5432/$TESTDB" node --test tests/manual-sync-db.integration.test.mjs'
