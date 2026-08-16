#!/usr/bin/env bash
#
# End-to-end verification against a real stack.
#
#   ./scripts/e2e.sh              build, run everything, tear down
#   ./scripts/e2e.sh --keep       leave it running afterwards to poke at
#   ./scripts/e2e.sh --no-build   reuse the existing app image (faster reruns)
#
# Brings up Postgres, Dendrite, Kubo and the app, drives a full user journey
# through the real HTTP API, then takes a backup, verifies it, destroys the
# data, restores it, and checks the data came back.
#
# The unit suite covers logic. This covers the things unit tests structurally
# cannot: that migrations apply to a real database, that Dendrite accepts what
# we send it, that files survive a round trip through IPFS, and that a restore
# actually restores. Every data-destroying bug found in this project so far was
# in code no test had ever executed.
#
# ─────────────────────────────────────────────────────────────────────────────
# SAFETY: this runs under its own compose project (sovrgnnet-e2e) with its own
# volumes. It never reads, writes, or deletes anything belonging to a real
# instance, and the teardown only removes volumes it created. Verified by
# asserting the project name before any destructive step.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PROJECT="sovrgnnet-e2e"
PORT="${E2E_PORT:-3999}"
BASE="http://localhost:$PORT"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo)
RED=$(tput setaf 1 2>/dev/null || echo); GREEN=$(tput setaf 2 2>/dev/null || echo)
YELLOW=$(tput setaf 3 2>/dev/null || echo)

KEEP=0
BUILD_ARG="--build"
FRESH=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) BUILD_ARG="" ;;
    # For when the image is suspected of being stale. Slow, and the answer
    # when a cached layer is serving code that no longer exists in the tree.
    --fresh) FRESH=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

step()  { printf '\n%s▸ %s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
info()  { printf '  %s%s%s\n' "$DIM" "$*" "$RESET"; }
die()   { printf '\n%s✗ %s%s\n\n' "$RED" "$*" "$RESET" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  die "Docker Compose isn't installed. This harness needs it."
fi

docker info >/dev/null 2>&1 || die "Docker isn't running."

# The override file uses the !override tag to replace the published port rather
# than append to it, which arrived in Compose v2.24. Without it the harness
# would try to bind 3000 as well and collide with a real instance — so check
# for it here instead of failing later with a port-in-use error.
COMPOSE_VERSION="$($DC version --short 2>/dev/null | tr -d 'v')"
if [ -n "$COMPOSE_VERSION" ]; then
  major="${COMPOSE_VERSION%%.*}"
  rest="${COMPOSE_VERSION#*.}"
  minor="${rest%%.*}"
  if [ "${major:-0}" -lt 2 ] || { [ "${major:-0}" -eq 2 ] && [ "${minor:-0}" -lt 24 ]; }; then
    die "Compose $COMPOSE_VERSION is too old — this needs v2.24+ for the port override."
  fi
fi

command -v pnpm >/dev/null 2>&1 || die "pnpm isn't on PATH."

# Everything below routes through here, so neither the project name nor the
# override file can be forgotten — including on the command that deletes
# volumes.
compose() {
  $DC -p "$PROJECT" \
    -f docker-compose.yml -f docker-compose.e2e.yml \
    --env-file "$ENV_FILE" "$@"
}

# --------------------------------------------------------------- environment

ENV_FILE="$(mktemp -t sovrgnnet-e2e-env.XXXXXX)"

secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

cat > "$ENV_FILE" <<EOF
DB_PASSWORD=$(secret)
JWT_SECRET=$(secret)
MATRIX_SHARED_SECRET=$(secret)
MATRIX_SERVER_NAME=e2e.local
MATRIX_HOMESERVER_URL=http://matrix:8008
# Advertised to clients; true inside the compose network, which is where the
# app's own reachability probe runs. The journey on the host talks to the
# published 127.0.0.1:8008 instead and knows the difference.
MATRIX_PUBLIC_URL=http://matrix:8008
IPFS_API_URL=http://ipfs:5001
INSTANCE_NAME=E2E instance
# Invite-only is the default a real install gets, so it's what should be
# exercised — including that a second signup is actually refused.
INSTANCE_JOIN_POLICY=invite
SOVRGNNET_ACCESS_MODE=lan
E2E_PORT=$PORT
EOF

WORK_DIR="$(mktemp -d -t sovrgnnet-e2e.XXXXXX)"

cleanup() {
  local code=$?
  if [ "$KEEP" -eq 1 ] && [ "$code" -eq 0 ]; then
    printf '\n%sLeft running at %s%s\n' "$DIM" "$BASE" "$RESET"
    printf '%sTear down with: %s -p %s down -v%s\n\n' "$DIM" "$DC" "$PROJECT" "$RESET"
  else
    printf '\n%sTearing down...%s\n' "$DIM" "$RESET"
    # Belt and braces: never let this line run against anything else.
    [ "$PROJECT" = "sovrgnnet-e2e" ] || die "refusing to remove volumes for '$PROJECT'"
    compose down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
  rm -f "$ENV_FILE"
  exit $code
}
trap cleanup EXIT

printf '\n%sSOVRGNnet end-to-end%s %s(project: %s, port %s)%s\n' \
  "$BOLD" "$RESET" "$DIM" "$PROJECT" "$PORT" "$RESET"

# ------------------------------------------------------------------- bring up

step "Configuring the homeserver"

# install.sh does this for a real install; the harness goes straight to
# `compose up`, so it has to do it too.
#
# Getting this wrong is silent and confusing: the compose file bind-mounts
# ./dendrite/dendrite.yaml, and Docker creates a *directory* when a bind-mount
# source doesn't exist. Dendrite then finds a directory where its config should
# be, fails to start, and the only symptom is that the homeserver never becomes
# reachable.
for stray in dendrite/dendrite.yaml dendrite/matrix_key.pem dendrite/appservice-e2e.yaml; do
  if [ -d "$stray" ]; then
    rmdir "$stray" 2>/dev/null || rm -rf "$stray"
    info "Removed $stray, which Docker had created as a directory"
  fi
done

mkdir -p dendrite

read_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

DENDRITE_SECRET="$(read_env MATRIX_SHARED_SECRET)"
DENDRITE_DB_PASS="$(read_env DB_PASSWORD)"
[ -n "$DENDRITE_SECRET" ] && [ -n "$DENDRITE_DB_PASS" ] \
  || die "Couldn't read the generated secrets back out of $ENV_FILE."

# Regenerated every run. A key left over from a previous run might be in the
# wrong format — an openssl-generated one was, and Dendrite refused it — and a
# throwaway stack has no reason to keep an identity between runs.
rm -f dendrite/matrix_key.pem
./scripts/generate-matrix-key.sh dendrite/matrix_key.pem \
  || die "Couldn't generate the homeserver signing key."
ok "Signing key generated (Dendrite format, verified)"

sed \
  -e "s|__MATRIX_SERVER_NAME__|e2e.local|g" \
  -e "s|__MATRIX_SHARED_SECRET__|$DENDRITE_SECRET|g" \
  -e "s|__DENDRITE_DISABLE_FEDERATION__|true|g" \
  -e "s|__DENDRITE_DATABASE_URL__|postgresql://sovrgn:$DENDRITE_DB_PASS@db:5432/dendrite?sslmode=disable|g" \
  dendrite/dendrite.yaml.template > dendrite/dendrite.yaml
chmod 600 dendrite/dendrite.yaml

# A leftover placeholder means the template gained a field this doesn't fill
# in, and Dendrite would fail on it in a way that takes a while to trace.
#
# Comments are excluded: the template's own header says "the __PLACEHOLDERS__
# are replaced", which is prose, not an unfilled slot.
LEFTOVER="$(grep -v '^\s*#' dendrite/dendrite.yaml | grep -o '__[A-Z_]*__' | sort -u || true)"
if [ -n "$LEFTOVER" ]; then
  printf '%s\n' "$LEFTOVER" | sed 's/^/    /'
  die "The Dendrite template has placeholders this script doesn't fill in."
fi
ok "Config written from the template"

# --- Appservice ingest (ADR 0009) -------------------------------------------
# The harness wires the registration a real operator would wire by hand, so
# eventIngest is true in the stack under test and the journey can prove a
# client-authored event lands in the index. Throwaway tokens per run.
E2E_AS_TOKEN="$(openssl rand -hex 32)"
E2E_HS_TOKEN="$(openssl rand -hex 32)"
export MATRIX_APPSERVICE_AS_TOKEN="$E2E_AS_TOKEN"
export MATRIX_APPSERVICE_HS_TOKEN="$E2E_HS_TOKEN"

sed \
  -e "s|{{AS_TOKEN}}|$E2E_AS_TOKEN|g" \
  -e "s|{{HS_TOKEN}}|$E2E_HS_TOKEN|g" \
  dendrite/appservice.yaml.template > dendrite/appservice-e2e.yaml
chmod 600 dendrite/appservice-e2e.yaml

# The production template deliberately ships without an app_service_api
# section (operators add it when they opt in — docs/UPGRADING.md). The
# harness opts in. Appending a top-level section to the rendered config is
# valid YAML as long as the template never grows its own; the guard below
# turns that collision into a loud failure instead of a duplicate-key one.
if grep -q '^app_service_api:' dendrite/dendrite.yaml; then
  die "dendrite.yaml.template now has app_service_api; e2e.sh must stop appending its own."
fi
cat >> dendrite/dendrite.yaml <<'YAML'

app_service_api:
  config_files:
    - /etc/dendrite/appservice-e2e.yaml
YAML
ok "Appservice registration wired (eventIngest will be live)"

step "Starting the stack"
info "Postgres, Dendrite, Kubo, and the app. First run builds the image."

# Start clean so a previous failed run can't make this one pass.
compose down -v --remove-orphans >/dev/null 2>&1 || true

if [ "$FRESH" -eq 1 ]; then
  info "Rebuilding the app image from scratch (--fresh)"
  compose build --no-cache app 2>&1 | tail -3 || die "The image failed to build."
fi

# shellcheck disable=SC2086
compose up -d $BUILD_ARG db matrix ipfs app 2>&1 | grep -Ei 'error|warn' || true

# --------------------------------------------------- check what was built
#
# The image is what runs, and it is not necessarily what `pnpm build` just
# produced on the host — a cached layer, a stale context, or a Dockerfile that
# copies the wrong thing all produce a container running different code.
#
# This exact failure happened twice: dist/index.js inside the image statically
# imported `vite`, which the production install doesn't have, so the container
# died on startup. The host bundle was clean and the unit test that checks it
# passed. Checking the artifact rather than the source is the difference.
step "Checking the image"

BUNDLE_IMPORTS="$(compose run --rm --no-deps --entrypoint node app \
  -e 'const s=require("fs").readFileSync("dist/index.js","utf8");
      const m=[...s.matchAll(/^\s*import\s+(?:[^;\x27"]*?\sfrom\s+)?["\x27]([^"\x27]+)["\x27]/gm)]
        .map(x=>x[1]).filter(x=>!x.startsWith(".")&&!x.startsWith("node:"));
      console.log(m.join(" "));' 2>/dev/null | tr -d '\r')"

for forbidden in vite @vitejs/plugin-react @tailwindcss/vite drizzle-kit; do
  case " $BUNDLE_IMPORTS " in
    *" $forbidden "*)
      printf '\n%sThe image imports %s, which is a devDependency.%s\n' "$RED" "$forbidden" "$RESET" >&2
      printf '%sThe container will die on startup with ERR_MODULE_NOT_FOUND.%s\n\n' "$DIM" "$RESET" >&2
      printf '%sThe host bundle may well be fine — this is the image.%s\n' "$DIM" "$RESET" >&2
      printf '%sMost likely a cached build layer. Rebuild without cache:%s\n' "$DIM" "$RESET" >&2
      printf '  %s%s -p %s build --no-cache app%s\n\n' "$BOLD" "$DC" "$PROJECT" "$RESET" >&2
      die "The built image is broken."
      ;;
  esac
done
ok "No development-only packages in the image's bundle"

# ---------------------------------------------------------------- wait for it

step "Waiting for readiness"

deadline=$(( $(date +%s) + 180 ))
ready=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  # /ready is the right thing to poll: it reports per-dependency status rather
  # than just whether the process is listening.
  if body=$(curl -fsS --max-time 5 "$BASE/ready" 2>/dev/null); then
    if printf '%s' "$body" | grep -q '"ready":true'; then ready=1; break; fi
  fi
  sleep 3
done

[ "$ready" -eq 1 ] || {
  printf '\n%sLast /ready response:%s\n' "$DIM" "$RESET"
  curl -sS --max-time 5 "$BASE/ready" 2>&1 | head -5 || echo "  (no response)"
  printf '\n%sApp logs:%s\n' "$DIM" "$RESET"
  compose logs --tail 40 app 2>&1 | tail -40
  die "The stack never became ready."
}

ok "Ready: $(curl -fsS "$BASE/ready")"

# Matrix takes longer than the app; the journey needs it, so wait separately
# rather than letting the first message send fail confusingly.
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  curl -fsS --max-time 5 "$BASE/ready" 2>/dev/null | grep -q '"matrix":"ok"' && break
  sleep 3
done
if curl -fsS "$BASE/ready" 2>/dev/null | grep -q '"matrix":"ok"'; then
  ok "Homeserver reachable"
else
  compose logs --tail 30 matrix 2>&1 | tail -30
  die "Dendrite never came up. The journey can't run without it."
fi

# --------------------------------------------------------------- conformance

step "Protocol conformance"
if pnpm exec tsx scripts/conformance.ts "$BASE"; then
  ok "Conformant"
else
  die "The instance doesn't conform to its own protocol."
fi

# ------------------------------------------------------------------- journey

step "User journey"
info "Register, create, post, upload, invite, join, permissions."

E2E_BASE="$BASE" E2E_WORK="$WORK_DIR" pnpm exec tsx scripts/e2e-journey.ts \
  || die "The journey failed."

# -------------------------------------------------------------------- crypto
#
# The journey drives HTTP and cannot encrypt anything. This runs the shipped
# crypto module itself — two device-scoped sessions, real Olm, real Megolm,
# against the Dendrite above — because nothing else in this repository proves
# a message ever becomes ciphertext or ever comes back.

step "Crypto"
info "Two devices, a room key, and bytes the instance can't read."

E2E_BASE="$BASE" E2E_WORK="$WORK_DIR" pnpm exec tsx scripts/e2e-crypto.ts \
  || die "The crypto checks failed."
ok "real Olm/Megolm end to end"

# ------------------------------------------------- backup / verify / restore

step "Backup, verify, restore"
info "The path where every data-destroying bug in this project has been found."

# Take a backup using the real script, against this stack.
BACKUP_OUT="$WORK_DIR/backup"
mkdir -p "$BACKUP_OUT"

# backup.sh drives docker compose itself, so it needs the same project and env.
# Rather than reimplement it, run its steps through the same entry point with
# the environment pointed at the e2e stack.
if ! COMPOSE_PROJECT_NAME="$PROJECT" \
     SOVRGNNET_ENV_FILE="$ENV_FILE" \
     ./scripts/e2e-backup.sh "$PROJECT" "$ENV_FILE" "$BACKUP_OUT"; then
  die "Backup failed."
fi
ok "Backup taken"

ARCHIVE="$(ls -1 "$BACKUP_OUT"/*.tar.gz 2>/dev/null | head -1)"
[ -n "$ARCHIVE" ] || die "Backup produced no archive."

if ./scripts/verify-backup.sh "$ARCHIVE"; then
  ok "Backup verifies"
else
  die "The backup we just took does not verify."
fi

# Destroy the data. This is the point: a restore that has never followed an
# actual data loss has never been tested.
step "Destroying the database"
compose exec -T db psql -U sovrgn -d sovrgnnet -c \
  'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' >/dev/null \
  || die "Couldn't drop the schema."
ok "Schema dropped"

compose restart app >/dev/null 2>&1 || true
sleep 8

step "Restoring"
EXTRACT="$WORK_DIR/restore"
mkdir -p "$EXTRACT"
tar xzf "$ARCHIVE" -C "$EXTRACT"
RESTORED="$(find "$EXTRACT" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -n "$RESTORED" ] || die "Couldn't extract the backup."

compose exec -T db psql -U sovrgn -d sovrgnnet -v ON_ERROR_STOP=0 \
  < "$RESTORED/database.sql" >/dev/null 2>&1 || true
ok "Database restored"

# The homeserver's own database. Restoring the app's without this leaves every
# channel pointing at a room the homeserver has never heard of — structure
# intact, history gone. That was a real bug, and skipping it here would mean
# the harness never exercised the fix.
if [ -f "$RESTORED/dendrite.sql" ]; then
  compose exec -T db psql -U sovrgn -d dendrite -v ON_ERROR_STOP=0 \
    < "$RESTORED/dendrite.sql" >/dev/null 2>&1 || true
  ok "Chat history restored"
else
  die "The backup carried no homeserver database — restore is untested."
fi

# The signing key is the instance's Matrix identity. Restoring everything else
# without it silently produces a different server.
if [ -f "$RESTORED/matrix_key.pem" ]; then
  BEFORE="$(sha256sum dendrite/matrix_key.pem | cut -d' ' -f1)"
  install -m 600 "$RESTORED/matrix_key.pem" dendrite/matrix_key.pem
  AFTER="$(sha256sum dendrite/matrix_key.pem | cut -d' ' -f1)"
  [ "$BEFORE" = "$AFTER" ] || die "The restored signing key differs from the one backed up."
  ok "Signing key restored, and identical"
else
  die "The backup carried no signing key — the instance would become a different server."
fi

compose restart app >/dev/null 2>&1 || true

deadline=$(( $(date +%s) + 90 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  curl -fsS --max-time 5 "$BASE/ready" 2>/dev/null | grep -q '"ready":true' && break
  sleep 3
done

step "Confirming the data survived"
E2E_BASE="$BASE" E2E_WORK="$WORK_DIR" E2E_MODE=verify-restore \
  pnpm exec tsx scripts/e2e-journey.ts \
  || die "Data did not survive the restore."

printf '\n%s%sEnd-to-end passed.%s\n' "$BOLD" "$GREEN" "$RESET"
printf '%sStack came up, conformed, served a full journey, backed up,%s\n' "$DIM" "$RESET"
printf '%sverified, survived a schema drop, and restored.%s\n\n' "$DIM" "$RESET"
