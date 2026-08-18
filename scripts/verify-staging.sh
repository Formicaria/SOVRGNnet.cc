#!/usr/bin/env bash
#
# Verify a staging instance the way a user would meet it — over HTTP, from
# outside, with no shell on the box.
#
#   ./scripts/verify-staging.sh http://192.168.1.60:3000
#   STAGING_SETUP_TOKEN=... ./scripts/verify-staging.sh http://staging:3000
#   STAGING_EMAIL=... STAGING_PASSWORD=... ./scripts/verify-staging.sh https://staging.example
#
# Runs the conformance suite (read-only), then the staging journey (creates a
# clearly-named throwaway community; needs one of the two auth modes above),
# then checks /metrics answers. docs/STAGING.md is the box; this is the proof.
#
# ─────────────────────────────────────────────────────────────────────────────
# THIS SCRIPT REFUSES PRODUCTION. Everything before it existed was verified
# against the live instance because it was the only instance, and every one of
# those sessions started with "is anyone using it right now". The refusal is
# by hostname here and by the instance's own reported server name inside the
# journey — both hardcoded, because a configurable refusal is a refusal
# someone configures away.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo)
RED=$(tput setaf 1 2>/dev/null || echo); GREEN=$(tput setaf 2 2>/dev/null || echo)

step() { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
die()  { printf '\n%s✗ %s%s\n\n' "$RED" "$*" "$RESET" >&2; exit 1; }

BASE="${1:-}"
[ -n "$BASE" ] || { sed -n '2,12p' "$0"; exit 2; }

case "$BASE" in
  http://*|https://*) ;;
  *) die "The address needs a scheme: http://host:port or https://host" ;;
esac

# The hostname half of the production refusal. The journey re-checks against
# what the instance says its server name is, which catches production reached
# by IP or through some other name.
HOST="$(printf '%s' "$BASE" | sed -E 's|^https?://||; s|/.*$||; s|:[0-9]+$||' | tr 'A-Z' 'a-z')"
case "$HOST" in
  sovrgnnet.cc|app.sovrgnnet.cc|www.sovrgnnet.cc|id.sovrgnnet.cc)
    die "That is production ($HOST). This script creates accounts and communities; it does not run there."
    ;;
esac

command -v pnpm >/dev/null 2>&1 || die "pnpm isn't on PATH."

printf '\n%sSOVRGNnet staging verification%s %s(%s)%s\n' "$BOLD" "$RESET" "$DIM" "$BASE" "$RESET"

step "Protocol conformance (read-only)"
pnpm exec tsx scripts/conformance.ts "$BASE" || die "The instance doesn't conform to the protocol."
ok "Conformant"

step "User journey (writes: one throwaway community, named as such)"
STAGING_BASE="$BASE" pnpm exec tsx scripts/staging-journey.ts || die "The journey failed."

step "Metrics"
if METRICS="$(curl -fsS --max-time 10 "$BASE/metrics" 2>/dev/null)"; then
  printf '%s' "$METRICS" | grep -q '^sovrgnnet_' || die "/metrics answers but exposes no sovrgnnet_ series."
  printf '%s' "$METRICS" | grep -q '^sovrgnnet_homeserver_up 1' \
    || die "the instance's own metrics say its homeserver is down."
  ok "/metrics healthy, homeserver up"
else
  # Metrics may be bound away from the public edge on purpose; absence is
  # reported, not failed, because the journey already proved the app works.
  printf '  %s– /metrics not reachable from here (may be deliberate)%s\n' "$DIM" "$RESET"
fi

printf '\n%s%sStaging verified.%s\n' "$BOLD" "$GREEN" "$RESET"
printf '%sConformant, served a user journey, and told the truth about its capabilities.%s\n\n' "$DIM" "$RESET"
