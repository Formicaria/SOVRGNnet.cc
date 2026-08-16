#!/usr/bin/env bash
#
# Run the integration tests that need a real database.
#
#   ./scripts/test-db.sh          bring up Postgres, run them, tear down
#   ./scripts/test-db.sh --keep   leave Postgres running for repeat runs
#
# 28 tests skip themselves without DATABASE_URL. That is correct behaviour —
# a missing database shouldn't look like a failure — but it means the default
# `pnpm test` silently covers less than it appears to, and the gap only shows
# up in CI. This closes it locally with one command.
#
# Runs its own throwaway Postgres on a spare port, so it never touches a real
# instance's data.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

CONTAINER="sovrgnnet-test-db"
PORT="${TEST_DB_PORT:-55432}"
PASSWORD="test-only-not-a-secret"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo)
RED=$(tput setaf 1 2>/dev/null || echo); GREEN=$(tput setaf 2 2>/dev/null || echo)

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

die() { printf '\n%s✗ %s%s\n\n' "$RED" "$*" "$RESET" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker isn't installed."
docker info >/dev/null 2>&1 || die "Docker isn't running."

cleanup() {
  local code=$?
  if [ "$KEEP" -eq 1 ]; then
    printf '\n%sPostgres left running on :%s%s\n' "$DIM" "$PORT" "$RESET"
    printf '%sStop it with: docker rm -f %s%s\n\n' "$DIM" "$CONTAINER" "$RESET"
  else
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  exit $code
}
trap cleanup EXIT

printf '\n%sIntegration tests%s %s(throwaway Postgres on :%s)%s\n\n' \
  "$BOLD" "$RESET" "$DIM" "$PORT" "$RESET"

# Reuse a container left by --keep rather than failing on the name.
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_DB=sovrgnnet \
    -e POSTGRES_USER=sovrgn \
    -e POSTGRES_PASSWORD="$PASSWORD" \
    -p "$PORT:5432" \
    postgres:16.6-alpine >/dev/null \
    || die "Couldn't start Postgres. Is port $PORT already in use?"
fi

printf '  %sWaiting for Postgres...%s\n' "$DIM" "$RESET"
deadline=$(( $(date +%s) + 60 ))
until docker exec "$CONTAINER" pg_isready -U sovrgn -d sovrgnnet >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || die "Postgres never became ready."
  sleep 1
done
printf '  %s✓%s Ready\n\n' "$GREEN" "$RESET"

export DATABASE_URL="postgresql://sovrgn:${PASSWORD}@localhost:${PORT}/sovrgnnet"
export JWT_SECRET="${JWT_SECRET:-test-secret-for-integration-tests}"

# The suite expects the schema to exist. In production the app applies
# migrations at boot, but the tests don't boot the app — and server/migrate.ts
# only exports functions, so running it directly would silently do nothing.
# drizzle-kit reads DATABASE_URL through drizzle.config.ts.
printf '  %sApplying migrations...%s\n' "$DIM" "$RESET"
if ! migrate_output="$(pnpm exec drizzle-kit migrate 2>&1)"; then
  printf '%s\n' "$migrate_output" | tail -15
  die "Couldn't apply migrations."
fi
printf '  %s✓%s Schema ready\n' "$GREEN" "$RESET"

pnpm exec vitest run

printf '\n%s%sIntegration tests passed.%s\n\n' "$BOLD" "$GREEN" "$RESET"
