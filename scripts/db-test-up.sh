#!/usr/bin/env bash
# Starts a throwaway postgres:17 container for the @pick-league/db integration tests.
# Usage: bun run db:test:up   (then export the printed DATABASE_URL_TEST and run bun test)
# Stop it with: bun run db:test:down
set -euo pipefail
# Git Bash on Windows would rewrite /var/... container paths into C:/Program Files/Git/var/...
export MSYS_NO_PATHCONV=1

NAME=pick-league-test-db
PORT=${PICKLEAGUE_TEST_DB_PORT:-55432}
URL="postgres://postgres:postgres@localhost:${PORT}/pickleague_test"

# Docker Desktop may still be starting: wait up to 2 minutes.
for i in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  if [ "$i" = 60 ]; then
    echo "Docker is not running (docker info kept failing for 2 minutes)." >&2
    exit 1
  fi
  echo "Waiting for Docker..." >&2
  sleep 2
done

if [ -z "$(docker ps -q -f "name=^${NAME}$")" ]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pickleague_test \
    -p "127.0.0.1:${PORT}:5432" --tmpfs /var/lib/postgresql/data \
    postgres:17 >/dev/null
fi

for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U postgres -d pickleague_test -h 127.0.0.1 >/dev/null 2>&1; then
    echo "Test database ready. Run:"
    echo "  export DATABASE_URL_TEST=${URL}"
    echo "  bun test"
    exit 0
  fi
  sleep 1
done
echo "Postgres did not become ready in time." >&2
exit 1
