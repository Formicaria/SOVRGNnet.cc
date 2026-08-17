#!/usr/bin/env bash
#
# Everything that can go wrong, checked before you push.
#
#   ./scripts/preflight.sh          the fast checks (~1 min)
#   ./scripts/preflight.sh --full   plus integration and end-to-end (~10 min)
#
# Ordered cheapest-first and stops at the first failure, so a typo doesn't cost
# a Docker build to discover.
#
# The habit this is trying to replace is pushing and letting CI find out. That
# loop is ten minutes long, happens in a different environment, and has
# repeatedly failed on things that were checkable locally in seconds.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo)
RED=$(tput setaf 1 2>/dev/null || echo); GREEN=$(tput setaf 2 2>/dev/null || echo)
YELLOW=$(tput setaf 3 2>/dev/null || echo)

FULL=0
[ "${1:-}" = "--full" ] && FULL=1

STARTED=$(date +%s)
STEP=0

step() {
  STEP=$((STEP + 1))
  printf '\n%s[%d] %s%s\n' "$BOLD" "$STEP" "$*" "$RESET"
}

pass() { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
skip() { printf '  %s- %s%s\n' "$DIM" "$*" "$RESET"; }

fail() {
  printf '\n%s%s✗ %s%s\n' "$BOLD" "$RED" "$*" "$RESET"
  printf '%sStopped at step %d. Nothing pushed.%s\n\n' "$DIM" "$STEP" "$RESET"
  exit 1
}

run() {
  local what="$1"; shift
  local output
  if output="$("$@" 2>&1)"; then
    pass "$what"
  else
    printf '%s\n' "$output" | tail -25
    fail "$what"
  fi
}

printf '\n%sPreflight%s %s(%s)%s\n' "$BOLD" "$RESET" "$DIM" \
  "$([ "$FULL" -eq 1 ] && echo "full" || echo "fast — use --full before a release")" "$RESET"

# ---------------------------------------------------------------- cheap first

step "Dependencies installed"

# Checked before anything else because the failure is otherwise reported by
# whichever tool happens to be missing — `sh: 1: tsc: not found` at step 3 tells
# you nothing about the actual problem, which is that the lockfile moved and
# node_modules didn't.
missing=""
for tool in tsc vitest esbuild vite tsx; do
  [ -x "node_modules/.bin/$tool" ] || missing="$missing $tool"
done

if [ -n "$missing" ]; then
  printf '  %smissing:%s%s\n\n' "$DIM" "$missing" "$RESET"
  printf '  %sRun:%s pnpm install\n' "$BOLD" "$RESET"
  printf '  %sDependencies changed in v0.4.0 — 17 packages were removed and the%s\n' "$DIM" "$RESET"
  printf '  %slockfile regenerated, so an older node_modules is out of date.%s\n' "$DIM" "$RESET"
  fail "dependencies not installed"
fi
pass "toolchain present"

# The lockfile is the thing CI installs from, so a mismatch here is a mismatch
# there. --frozen-lockfile fails rather than silently resolving something else.
if ! pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1; then
  printf '  %sThe lockfile and package.json disagree, or a package is missing.%s\n' "$DIM" "$RESET"
  printf '  %sRun:%s pnpm install\n' "$BOLD" "$RESET"
  fail "lockfile out of sync — CI installs with --frozen-lockfile and would fail too"
fi
pass "lockfile matches package.json"

step "Versions agree"
run "six files on one version" ./scripts/check-versions.sh

step "Shell scripts parse"
for f in scripts/*.sh install.sh sovrgnnet; do
  bash -n "$f" || fail "$f has a syntax error"
done
pass "$(ls scripts/*.sh | wc -l | tr -d ' ') scripts plus install.sh and sovrgnnet"

step "Typecheck"
run "root" pnpm check

step "Unit tests"
if output="$(pnpm test 2>&1)"; then
  # The summary line, not the per-file ones — those also say "skipped" and
  # report a different, smaller number.
  summary="$(printf '%s\n' "$output" | grep -E "^ +Tests +[0-9]" | tail -1)"
  printf '%s\n' "$summary" | sed 's/^ */  /'

  # A run where the database tests skip covers less than it looks like it does,
  # and the gap otherwise only shows up in CI.
  skipped="$(printf '%s' "$summary" | grep -oE '[0-9]+ skipped' || true)"
  [ -n "$skipped" ] && skip "$skipped — run --full, or ./scripts/test-db.sh"

  pass "unit suite"
else
  printf '%s\n' "$output" | tail -30
  fail "unit tests"
fi

step "Build"
run "production bundle" pnpm build

# ------------------------------------------------------------- other packages

# Runs a command inside a directory without a subshell.
#
# `( cd x && run ... )` looks equivalent and is not: `fail` calls exit, which
# in a subshell exits only the subshell. A failing desktop typecheck would have
# been reported and then ignored, which is worse than not checking it.
run_in() {
  local dir="$1" what="$2"; shift 2
  local output
  if output="$(cd "$dir" && "$@" 2>&1)"; then
    pass "$what"
  else
    printf '%s\n' "$output" | tail -25
    fail "$what"
  fi
}

step "Desktop"
if [ -d desktop/node_modules ]; then
  run_in desktop "typecheck" pnpm exec tsc --noEmit
  run_in desktop "bundle" pnpm exec vite build
else
  skip "desktop dependencies not installed (cd desktop && pnpm install)"
fi

step "Identity provider"
if [ -d identity/node_modules ]; then
  run_in identity "typecheck" pnpm exec tsc --noEmit
  # Typecheck alone was all this stage did while the service was already live
  # holding the key that mints tokens for every server trusting this issuer.
  # It proved the types lined up and exercised nothing.
  run_in identity "unit tests" pnpm exec vitest run
else
  skip "identity dependencies not installed (cd identity && pnpm install)"
fi

step "Static site"
if [ -d site ]; then
  # Cheap, and the site has no build step to catch a typo'd href.
  if output="$(./scripts/check-site.sh 2>&1)"; then
    printf '%s\n' "$output" | grep -E '✓|!' | sed 's/^/  /' | sed 's/^  *  /  /'
    pass "links, assets, CSP, version claims"
  else
    printf '%s\n' "$output" | tail -20
    fail "static site"
  fi
else
  skip "no site directory"
fi

# ------------------------------------------------------------------ the slow

if [ "$FULL" -eq 0 ]; then
  ELAPSED=$(( $(date +%s) - STARTED ))
  printf '\n%s%sPreflight passed%s %s(%ss)%s\n' "$BOLD" "$GREEN" "$RESET" "$DIM" "$ELAPSED" "$RESET"
  printf '%sSkipped: integration and end-to-end. Run --full before a release.%s\n\n' "$DIM" "$RESET"
  exit 0
fi

# Why Docker can't be used, specifically.
#
# "Docker unavailable" is three different problems with three different fixes,
# and the most common one — your user not being in the docker group — looks
# identical to not having it installed.
docker_problem() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'not installed\n     %sInstall it: sudo apt install docker.io docker-compose-v2%s' "$DIM" "$RESET"
    return
  fi

  if docker info >/dev/null 2>&1; then return 1; fi

  # Distinguish "daemon down" from "you can't reach the socket".
  local err
  err="$(docker info 2>&1 || true)"
  if printf '%s' "$err" | grep -qi "permission denied"; then
    printf 'permission denied on the Docker socket\n'
    printf '     %sYour user is not in the docker group. Fix with:%s\n' "$DIM" "$RESET"
    printf '     %ssudo usermod -aG docker $USER && newgrp docker%s' "$BOLD" "$RESET"
  elif printf '%s' "$err" | grep -qiE "cannot connect|is the docker daemon running"; then
    printf 'the daemon is not running\n'
    printf '     %sStart it: sudo systemctl enable --now docker%s' "$BOLD" "$RESET"
  else
    printf 'unavailable\n     %s%s%s' "$DIM" "$(printf '%s' "$err" | head -2)" "$RESET"
  fi
}

# Two separate capabilities, because they gate different steps. The integration
# tests need only the daemon; the end-to-end harness also needs Compose. Rolling
# them into one flag would skip the tests that can actually run.
DOCKER_READY=0
COMPOSE_READY=0

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  DOCKER_READY=1
  if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_READY=1
  fi
else
  DOCKER_NOTE="$(docker_problem)"
fi

step "Integration tests (real Postgres)"
if [ "$DOCKER_READY" -eq 1 ]; then
  ./scripts/test-db.sh || fail "integration tests"
  pass "against a real database"
else
  skip "Docker: $DOCKER_NOTE"
fi

step "End-to-end (full stack)"
if [ "$COMPOSE_READY" -eq 1 ]; then
  ./scripts/e2e.sh || fail "end-to-end"
  pass "stack, journey, backup, restore"
elif [ "$DOCKER_READY" -eq 1 ]; then
  skip "Docker Compose isn't installed"
  printf '     %sDocker CE: %ssudo apt install docker-compose-plugin%s\n' "$DIM" "$BOLD" "$RESET"
  printf '     %sUbuntu/Pop!_OS docker.io: sudo apt install docker-compose-v2%s\n' "$DIM" "$RESET"
else
  skip "Docker: $DOCKER_NOTE"
fi

# A --full run that skipped the steps --full exists for should not print the
# same success as one that ran them.
if [ "$COMPOSE_READY" -eq 0 ]; then
  ELAPSED=$(( $(date +%s) - STARTED ))
  printf '\n%s%sPartially verified%s %s(%ss)%s\n' "$BOLD" "$YELLOW" "$RESET" "$DIM" "$ELAPSED" "$RESET"
  if [ "$DOCKER_READY" -eq 1 ]; then
    printf '%sEverything ran except end-to-end, which needs Compose.%s\n\n' "$DIM" "$RESET"
  else
    printf '%sIntegration and end-to-end did not run, which is what --full is for.%s\n\n' "$DIM" "$RESET"
  fi
  exit 0
fi

ELAPSED=$(( $(date +%s) - STARTED ))
printf '\n%s%sPreflight passed%s %s(%ss)%s\n\n' "$BOLD" "$GREEN" "$RESET" "$DIM" "$ELAPSED" "$RESET"
