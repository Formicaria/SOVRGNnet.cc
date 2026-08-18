#!/usr/bin/env bash
#
# Run the identity tests that need a real database.
#
#   ./identity/scripts/test-db.sh          bring up Postgres, run them, tear down
#   ./identity/scripts/test-db.sh --keep   leave it running for repeat runs
#
# A throwaway Postgres on a spare port, the same shape as the main server's
# scripts/test-db.sh.
#
# Emphatically *not* the live database at id.sovrgnnet.cc. These tests register
# accounts, redeem device codes, spend recovery codes and truncate tables
# between runs. Pointed at production that is not a test suite, it is a script
# that deletes every identity on the network — and it would also burn the rate
# limiter's counters and leave test accounts in the real account table.
#
# The identity service is the one component whose database has no equivalent
# elsewhere: an instance's data can be restored from a backup taken an hour
# ago, but an account subject is what every server on the network keys its
# local user off. Losing those is not recoverable by restoring anything.

set -euo pipefail

IDENTITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$IDENTITY_DIR"

CONTAINER="sovrgnnet-identity-test-db"
PORT="${IDENTITY_TEST_DB_PORT:-55433}"
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

printf '\n%sIdentity route tests%s %s(throwaway Postgres on :%s)%s\n\n' \
  "$BOLD" "$RESET" "$DIM" "$PORT" "$RESET"

# A different port and a different container name from the main server's, so
# the two can run at once and neither can be mistaken for the other.
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_DB=sovrgnnet_identity \
    -e POSTGRES_USER=identity \
    -e POSTGRES_PASSWORD="$PASSWORD" \
    -p "$PORT:5432" \
    postgres:16.6-alpine >/dev/null \
    || die "Couldn't start Postgres. Is port $PORT already in use?"
fi

printf '  %sWaiting for Postgres...%s\n' "$DIM" "$RESET"
deadline=$(( $(date +%s) + 60 ))
until docker exec "$CONTAINER" pg_isready -U identity -d sovrgnnet_identity >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || die "Postgres never became ready."
  sleep 1
done
printf '  %s✓%s Ready\n\n' "$GREEN" "$RESET"

export IDENTITY_TEST_DATABASE_URL="postgresql://identity:${PASSWORD}@localhost:${PORT}/sovrgnnet_identity"

# Deliberately a distinct variable from DATABASE_URL. If these tests read the
# same name the main server uses, running them with a production environment
# sourced would point them at whatever that shell happened to have — and the
# failure would be silent, destructive, and discovered afterwards.
export DATABASE_URL="$IDENTITY_TEST_DATABASE_URL"

printf '  %sApplying migrations...%s\n' "$DIM" "$RESET"
if ! migrate_output="$(pnpm exec drizzle-kit migrate 2>&1)"; then
  printf '%s\n' "$migrate_output" | tail -15
  die "Couldn't apply migrations."
fi
printf '  %s✓%s Schema ready\n' "$GREEN" "$RESET"

pnpm exec vitest run

printf '\n%s%sIdentity route tests passed.%s\n\n' "$BOLD" "$GREEN" "$RESET"
