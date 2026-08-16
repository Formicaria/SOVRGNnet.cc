#!/usr/bin/env bash
#
# Federation, tested rather than merely possible — ADR 0010's completion
# criterion, run for real.
#
#   ./scripts/e2e-federation.sh              build, run everything, tear down
#   ./scripts/e2e-federation.sh --keep       leave both instances up afterwards
#   ./scripts/e2e-federation.sh --no-build   reuse existing app images
#
# Stands up TWO complete instances — each its own app, Postgres, Dendrite,
# and Kubo, under its own compose project — connects only the homeservers
# over a shared network, and proves the 0.7 claim end to end:
#
#   · a federated invite crosses from A to B, and B joins A's room
#   · messages cross in both directions
#   · both indexes record both senders — one attributed to a local account,
#     one held as a bare Matrix id with userId null (ADR 0010)
#   · a redaction by A's moderator clears both indexes
#   · neither instance's conformance nor /metrics regresses
#
# One splice is done at the database rather than through a product surface:
# instance B's channel row pointing at A's room is INSERTed directly, because
# the product has no "attach a remote room" affordance yet — that is future
# 0.7+ work, and ADR 0010 says it must not block this proof. Everything else
# is the real wire: real federation transport, real appservice pushes, real
# HTTP API. When the attach surface exists, that INSERT is what it replaces.
#
# ─────────────────────────────────────────────────────────────────────────────
# SAFETY: two dedicated compose projects (sovrgnnet-fed-a, sovrgnnet-fed-b)
# with their own volumes and a dedicated shared network. Nothing belonging to
# a real instance is read, written, or removed; teardown asserts the project
# names before every destructive step.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

PROJECT_A="sovrgnnet-fed-a"
PROJECT_B="sovrgnnet-fed-b"
NET="sovrgnnet-fed"

PORT_A="${FED_PORT_A:-4101}"
PORT_B="${FED_PORT_B:-4102}"
MPORT_A="${FED_MPORT_A:-18008}"
MPORT_B="${FED_MPORT_B:-28008}"
NAME_A="matrix-a"
NAME_B="matrix-b"
BASE_A="http://localhost:$PORT_A"
BASE_B="http://localhost:$PORT_B"

BOLD=$(tput bold 2>/dev/null || echo); RESET=$(tput sgr0 2>/dev/null || echo)
DIM=$(tput dim 2>/dev/null || echo)
RED=$(tput setaf 1 2>/dev/null || echo); GREEN=$(tput setaf 2 2>/dev/null || echo)

KEEP=0
BUILD_ARG="--build"
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --no-build) BUILD_ARG="" ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
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
command -v openssl >/dev/null 2>&1 || die "openssl isn't on PATH — needed for the throwaway TLS pairs."
command -v node >/dev/null 2>&1 || die "node isn't on PATH."

compose_a() { $DC -p "$PROJECT_A" -f docker-compose.yml -f docker-compose.federation.yml --env-file "$ENV_A" "$@"; }
compose_b() { $DC -p "$PROJECT_B" -f docker-compose.yml -f docker-compose.federation.yml --env-file "$ENV_B" "$@"; }

psql_a() { compose_a exec -T db psql -U sovrgn -d sovrgnnet -tA -c "$1"; }
psql_b() { compose_b exec -T db psql -U sovrgn -d sovrgnnet -tA -c "$1"; }

# --------------------------------------------------------------- environment

secret() { head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

ENV_A="$(mktemp -t sovrgnnet-fed-a-env.XXXXXX)"
ENV_B="$(mktemp -t sovrgnnet-fed-b-env.XXXXXX)"
WORK_DIR="$(mktemp -d -t sovrgnnet-fed.XXXXXX)"
STATE="$WORK_DIR/federation-state.json"

# One env file per instance: separate secrets, separate server names, and the
# FED_* variables docker-compose.federation.yml interpolates. Two instances
# sharing a JWT secret would be two instances trusting each other's sessions,
# which is precisely not the situation under test.
write_env() {
  local file="$1" fed_id="$2" app_port="$3" matrix_port="$4" alias="$5" label="$6"
  cat > "$file" <<EOF
DB_PASSWORD=$(secret)
JWT_SECRET=$(secret)
MATRIX_SHARED_SECRET=$(secret)
MATRIX_SERVER_NAME=$alias
MATRIX_HOMESERVER_URL=http://matrix:8008
MATRIX_PUBLIC_URL=http://matrix:8008
MATRIX_ALLOW_FEDERATION=true
MATRIX_APPSERVICE_AS_TOKEN=$(secret)
MATRIX_APPSERVICE_HS_TOKEN=$(secret)
IPFS_API_URL=http://ipfs:5001
INSTANCE_NAME=$label
INSTANCE_JOIN_POLICY=invite
SOVRGNNET_ACCESS_MODE=lan
FED_ID=$fed_id
FED_APP_PORT=$app_port
FED_MATRIX_PORT=$matrix_port
FED_MATRIX_ALIAS=$alias
FED_NETWORK=$NET
EOF
}

write_env "$ENV_A" a "$PORT_A" "$MPORT_A" "$NAME_A" "Federation A"
write_env "$ENV_B" b "$PORT_B" "$MPORT_B" "$NAME_B" "Federation B"

read_env() { sed -n "s/^$2=//p" "$1" | tail -1; }

CREATED_NET=0

cleanup() {
  local code=$?
  if [ "$KEEP" -eq 1 ] && [ "$code" -eq 0 ]; then
    printf '\n%sLeft running: A at %s, B at %s%s\n' "$DIM" "$BASE_A" "$BASE_B" "$RESET"
    printf '%sTear down with:%s\n' "$DIM" "$RESET"
    printf '%s  %s -p %s down -v && %s -p %s down -v && docker network rm %s%s\n\n' \
      "$DIM" "$DC" "$PROJECT_A" "$DC" "$PROJECT_B" "$NET" "$RESET"
  else
    printf '\n%sTearing down both instances...%s\n' "$DIM" "$RESET"
    [ "$PROJECT_A" = "sovrgnnet-fed-a" ] || die "refusing to remove volumes for '$PROJECT_A'"
    [ "$PROJECT_B" = "sovrgnnet-fed-b" ] || die "refusing to remove volumes for '$PROJECT_B'"
    compose_a down -v --remove-orphans >/dev/null 2>&1 || true
    compose_b down -v --remove-orphans >/dev/null 2>&1 || true
    if [ "$CREATED_NET" -eq 1 ]; then
      docker network rm "$NET" >/dev/null 2>&1 || true
    fi
  fi
  rm -rf "$WORK_DIR"
  rm -f "$ENV_A" "$ENV_B"
  exit $code
}
trap cleanup EXIT

printf '\n%sSOVRGNnet federation harness%s %s(A: %s · B: %s)%s\n' \
  "$BOLD" "$RESET" "$DIM" "$BASE_A" "$BASE_B" "$RESET"

# ------------------------------------------------- homeserver configuration

step "Configuring two homeservers"

# Docker creates a *directory* when a bind-mount source doesn't exist, and
# Dendrite then fails on a config that is a directory. Same guard as e2e.sh,
# for every file the federation override mounts.
for fed_id in a b; do
  for stray in dendrite.yaml matrix_key.pem appservice.yaml tls.crt tls.key; do
    path="dendrite/fed-$fed_id/$stray"
    if [ -d "$path" ]; then
      rmdir "$path" 2>/dev/null || rm -rf "$path"
      info "Removed $path, which Docker had created as a directory"
    fi
  done
  mkdir -p "dendrite/fed-$fed_id"
done

render_homeserver() {
  local fed_id="$1" env_file="$2" alias="$3"
  local dir="dendrite/fed-$fed_id"
  local shared_secret db_pass as_token hs_token

  shared_secret="$(read_env "$env_file" MATRIX_SHARED_SECRET)"
  db_pass="$(read_env "$env_file" DB_PASSWORD)"
  as_token="$(read_env "$env_file" MATRIX_APPSERVICE_AS_TOKEN)"
  hs_token="$(read_env "$env_file" MATRIX_APPSERVICE_HS_TOKEN)"
  [ -n "$shared_secret" ] && [ -n "$db_pass" ] && [ -n "$as_token" ] && [ -n "$hs_token" ] \
    || die "Couldn't read the generated secrets back out of $env_file."

  rm -f "$dir/matrix_key.pem"
  ./scripts/generate-matrix-key.sh "$dir/matrix_key.pem" \
    || die "Couldn't generate the signing key for $alias."

  sed \
    -e "s|__MATRIX_SERVER_NAME__|$alias|g" \
    -e "s|__MATRIX_SHARED_SECRET__|$shared_secret|g" \
    -e "s|__DENDRITE_DISABLE_FEDERATION__|false|g" \
    -e "s|__DENDRITE_DATABASE_URL__|postgresql://sovrgn:$db_pass@db:5432/dendrite?sslmode=disable|g" \
    dendrite/dendrite.yaml.template > "$dir/dendrite.yaml"
  chmod 600 "$dir/dendrite.yaml"

  LEFTOVER="$(grep -v '^\s*#' "$dir/dendrite.yaml" | grep -o '__[A-Z_]*__' | sort -u || true)"
  if [ -n "$LEFTOVER" ]; then
    printf '%s\n' "$LEFTOVER" | sed 's/^/    /'
    die "The Dendrite template has placeholders this script doesn't fill in."
  fi

  # Two harness-only transport settings, patched rather than templated so the
  # production template keeps its production values. Guarded: if the template
  # ever changes these lines, the patch must fail loudly, not silently render
  # a config that means something else.
  grep -q '^  disable_tls_validation: false$' "$dir/dendrite.yaml" \
    || die "dendrite.yaml.template changed shape: disable_tls_validation not found where expected."
  sed -i 's|^  disable_tls_validation: false$|  disable_tls_validation: true|' "$dir/dendrite.yaml"

  grep -q '^  prefer_direct_fetch: false$' "$dir/dendrite.yaml" \
    || die "dendrite.yaml.template changed shape: prefer_direct_fetch not found where expected."
  sed -i 's|^  prefer_direct_fetch: false$|  prefer_direct_fetch: true|' "$dir/dendrite.yaml"

  # Throwaway TLS pair for the federation listener. Self-signed and valid for
  # two days, because the other side skips validation and the stack outlives
  # neither the run nor the week.
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -keyout "$dir/tls.key" -out "$dir/tls.crt" \
    -subj "/CN=$alias" -addext "subjectAltName=DNS:$alias" >/dev/null 2>&1 \
    || die "Couldn't generate the TLS pair for $alias."
  chmod 644 "$dir/tls.crt" "$dir/tls.key"

  # Appservice registration (ADR 0009) — same opt-in the e2e harness does,
  # with this instance's throwaway tokens.
  sed \
    -e "s|{{AS_TOKEN}}|$as_token|g" \
    -e "s|{{HS_TOKEN}}|$hs_token|g" \
    dendrite/appservice.yaml.template > "$dir/appservice.yaml"
  chmod 600 "$dir/appservice.yaml"

  if grep -q '^app_service_api:' "$dir/dendrite.yaml"; then
    die "dendrite.yaml.template now has app_service_api; this script must stop appending its own."
  fi
  cat >> "$dir/dendrite.yaml" <<'YAML'

app_service_api:
  config_files:
    - /etc/dendrite/appservice-fed.yaml
YAML

  ok "$alias configured: federation on, TLS listener, appservice wired"
}

render_homeserver a "$ENV_A" "$NAME_A"
render_homeserver b "$ENV_B" "$NAME_B"

# ----------------------------------------------------------------- bring up

step "Starting both stacks"

if ! docker network inspect "$NET" >/dev/null 2>&1; then
  docker network create "$NET" >/dev/null
  CREATED_NET=1
  info "Created shared network $NET"
fi

# Start clean so a previous failed run can't make this one pass.
compose_a down -v --remove-orphans >/dev/null 2>&1 || true
compose_b down -v --remove-orphans >/dev/null 2>&1 || true

# shellcheck disable=SC2086
compose_a up -d $BUILD_ARG db matrix ipfs app 2>&1 | grep -Ei 'error' || true
# B reuses A's build cache, so the second one is quick.
# shellcheck disable=SC2086
compose_b up -d $BUILD_ARG db matrix ipfs app 2>&1 | grep -Ei 'error' || true

wait_ready() {
  local base="$1" label="$2" logs="$3"
  local deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -fsS --max-time 5 "$base/ready" 2>/dev/null | grep -q '"ready":true'; then
      ok "$label ready"
      return 0
    fi
    sleep 3
  done
  printf '\n%s%s never became ready. App logs:%s\n' "$RED" "$label" "$RESET"
  $logs logs --tail 40 app 2>&1 | tail -40
  die "$label never became ready."
}

wait_matrix() {
  local base="$1" label="$2" logs="$3"
  local deadline=$(( $(date +%s) + 120 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    curl -fsS --max-time 5 "$base/ready" 2>/dev/null | grep -q '"matrix":"ok"' && { ok "$label homeserver reachable"; return 0; }
    sleep 3
  done
  $logs logs --tail 30 matrix 2>&1 | tail -30
  die "$label's Dendrite never came up."
}

wait_ready "$BASE_A" "Instance A" compose_a
wait_ready "$BASE_B" "Instance B" compose_b
wait_matrix "$BASE_A" "A" compose_a
wait_matrix "$BASE_B" "B" compose_b

# ------------------------------------------------------------------ journey

journey() {
  FED_A_BASE="$BASE_A" FED_B_BASE="$BASE_B" \
  FED_A_MATRIX="http://127.0.0.1:$MPORT_A" FED_B_MATRIX="http://127.0.0.1:$MPORT_B" \
  FED_A_NAME="$NAME_A" FED_B_NAME="$NAME_B" \
  E2E_WORK="$WORK_DIR" FED_PHASE="$1" \
    pnpm exec tsx scripts/e2e-federation-journey.ts
}

step "Instance A: account, community, room"
journey setup-a || die "Phase setup-a failed."

step "Instance B: account, federated invite, federated join"
journey join-b || die "Phase join-b failed."

# --- The splice (see the header) --------------------------------------------
step "Attaching the room to B's index"

state_read() { node -pe 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))[process.argv[2]]' "$STATE" "$1"; }

ROOM_ID="$(state_read roomId)"
SERVER_ID_B="$(state_read serverIdB)"
[ -n "$ROOM_ID" ] && [ "$ROOM_ID" != "undefined" ] || die "No room id in the journey state."
[ -n "$SERVER_ID_B" ] && [ "$SERVER_ID_B" != "undefined" ] || die "No B community id in the journey state."

B_CHANNEL_ID="$(psql_b "INSERT INTO channels (\"serverId\", name, description, \"matrixRoomId\", type, \"isPrivate\", encrypted)
  VALUES ($SERVER_ID_B, 'bridged', 'Federated room from $NAME_A — indexed from the join onward', '$ROOM_ID', 'text', false, false)
  RETURNING id;")"
case "$B_CHANNEL_ID" in
  ''|*[!0-9]*) die "The channel splice on B returned no id: '$B_CHANNEL_ID'" ;;
esac

node -e '
  const fs = require("fs");
  const file = process.argv[1];
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.bChannelId = Number(process.argv[2]);
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
' "$STATE" "$B_CHANNEL_ID"
ok "B's index now holds the room as channel #$B_CHANNEL_ID (direct INSERT — no attach surface exists yet)"

step "Messages cross, both indexes attribute correctly"
journey cross || die "Phase cross failed."

# --- The index shape, asserted at the database ------------------------------
# The journey proved it through the API; this proves the rows themselves are
# what ADR 0010 says — because the API could in principle be presenting a
# shape the schema doesn't actually hold.
step "Index shape (ADR 0010), straight from both databases"

A_FED_ROWS="$(psql_a "SELECT count(*) FROM messages WHERE \"userId\" IS NULL AND \"senderMatrixId\" LIKE '%:$NAME_B';")"
[ "${A_FED_ROWS:-0}" -ge 1 ] || die "A's database holds no federated-sender rows (userId NULL + @…:$NAME_B)."
ok "A: $A_FED_ROWS row(s) with userId NULL and a $NAME_B sender"

B_FED_ROWS="$(psql_b "SELECT count(*) FROM messages WHERE \"userId\" IS NULL AND \"senderMatrixId\" LIKE '%:$NAME_A';")"
[ "${B_FED_ROWS:-0}" -ge 1 ] || die "B's database holds no federated-sender rows (userId NULL + @…:$NAME_A)."
ok "B: $B_FED_ROWS row(s) with userId NULL and a $NAME_A sender"

B_LOCAL_ROWS="$(psql_b "SELECT count(*) FROM messages WHERE \"userId\" IS NOT NULL AND \"senderMatrixId\" LIKE '%:$NAME_B';")"
[ "${B_LOCAL_ROWS:-0}" -ge 1 ] || die "B's database never attributed its own account's federated-room message."
ok "B: $B_LOCAL_ROWS row(s) attributed to a local account in the same room"

step "A redaction crosses and both indexes agree"
journey redact || die "Phase redact failed."

# ------------------------------------------------- no regression, either side

step "Protocol conformance, both instances"
pnpm exec tsx scripts/conformance.ts "$BASE_A" || die "Instance A stopped conforming under federation."
ok "A conformant"
pnpm exec tsx scripts/conformance.ts "$BASE_B" || die "Instance B stopped conforming under federation."
ok "B conformant"

step "Metrics, both instances"
for pair in "A|$BASE_A" "B|$BASE_B"; do
  label="${pair%%|*}"; base="${pair#*|}"
  METRICS="$(curl -fsS --max-time 10 "$base/metrics")" || die "$label's /metrics stopped answering."
  printf '%s' "$METRICS" | grep -q '^sovrgnnet_' \
    || die "$label's /metrics no longer exposes sovrgnnet_ metrics."
  printf '%s' "$METRICS" | grep -q '^sovrgnnet_homeserver_up 1' \
    || die "$label's own metrics say its homeserver is down."
  ok "$label /metrics healthy, homeserver up"
done

printf '\n%s%sFederation passed.%s\n' "$BOLD" "$GREEN" "$RESET"
printf '%sTwo instances, one room. Invites, messages, and redactions crossed;%s\n' "$DIM" "$RESET"
printf '%sboth indexes attributed both senders; conformance and metrics held.%s\n\n' "$DIM" "$RESET"
