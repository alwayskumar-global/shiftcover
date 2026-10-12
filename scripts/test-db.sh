#!/usr/bin/env bash
# Throwaway local Postgres for DB-backed tests (PLAN.md 6A: never test against the demo database).
# Usage: scripts/test-db.sh up|down|url
set -euo pipefail
NAME=shiftcover-test-pg
PORT=54329
case "${1:-}" in
  up)
    if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run --rm -d --name "$NAME" -e POSTGRES_PASSWORD=test -p 127.0.0.1:$PORT:5432 postgres:17 >/dev/null
    fi
    for _ in $(seq 1 40); do
      docker exec "$NAME" pg_isready -U postgres >/dev/null 2>&1 && { echo "test db ready on 127.0.0.1:$PORT"; exit 0; }
      sleep 0.5
    done
    echo "test db did not become ready" >&2; exit 1 ;;
  down) docker stop "$NAME" >/dev/null 2>&1 || true; echo "stopped" ;;
  url) echo "postgres://postgres:test@127.0.0.1:$PORT/postgres" ;;
  *) echo "usage: $0 up|down|url" >&2; exit 2 ;;
esac
