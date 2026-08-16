#!/usr/bin/env bash
#
# Take a backup of the end-to-end stack.
#
#   scripts/e2e-backup.sh <compose-project> <env-file> <output-dir>
#
# Not a second implementation of backup.sh — it produces the same layout and
# the same manifest, because the manifest is what verify-backup.sh reads and a
# harness that verified a different format would prove nothing.
#
# It exists because backup.sh discovers its own runtime from /etc or ./.env and
# drives the default compose project. The harness runs an isolated stack under
# its own project name, and pointing the real script at it would mean either
# teaching it about test environments or risking it finding the operator's
# actual instance. Neither is worth it.

set -euo pipefail

PROJECT="${1:?compose project name required}"
ENV_FILE="${2:?env file required}"
OUT_DIR="${3:?output directory required}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

compose() { $DC -p "$PROJECT" --env-file "$ENV_FILE" "$@"; }

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
NAME="sovrgnnet_backup_${TIMESTAMP}"
DEST="$OUT_DIR/$NAME"
mkdir -p "$DEST"

# --- database ---------------------------------------------------------------

compose exec -T db pg_dump -U sovrgn -d sovrgnnet --clean --if-exists \
  > "$DEST/database.sql" 2>/dev/null \
  || { echo "couldn't dump the app database" >&2; exit 1; }

# --- homeserver -------------------------------------------------------------

if compose exec -T db pg_dump -U sovrgn -d dendrite --clean --if-exists \
     > "$DEST/dendrite.sql" 2>/dev/null; then
  :
else
  rm -f "$DEST/dendrite.sql"
fi

# --- shared files -----------------------------------------------------------

if docker run --rm \
     -v "${PROJECT}_ipfs_data:/data:ro" \
     -v "$(cd "$DEST" && pwd):/backup" \
     alpine tar czf /backup/ipfs_data.tar.gz -C /data . 2>/dev/null; then
  :
else
  rm -f "$DEST/ipfs_data.tar.gz"
fi

# --- settings ---------------------------------------------------------------

cp "$ENV_FILE" "$DEST/env.backup"
chmod 600 "$DEST/env.backup"
echo "docker" > "$DEST/RUNTIME"

# --- manifest ---------------------------------------------------------------
# Identical shape to backup.sh, because verify-backup.sh is what reads it.

read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

json_string() {
  [ -n "$1" ] || { printf 'null'; return; }
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g')"
}

SERVER_NAME="$(read_env MATRIX_SERVER_NAME)"
SERVER_NAME="${SERVER_NAME:-unconfigured}"
INSTANCE_NAME="$(read_env INSTANCE_NAME)"
INSTANCE_ID="$(printf 'sovrgnnet:instance:%s' "$SERVER_NAME" | sha256sum | cut -c1-16)"

APP_VERSION="$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' package.json | head -1)"
SCHEMA="$(grep -o '"tag" *: *"[^"]*"' drizzle/meta/_journal.json 2>/dev/null \
  | tail -1 | sed 's/.*"\([^"]*\)"$/\1/')"

component_json() {
  local file="$1" name="$2"
  [ -f "$DEST/$file" ] || return 0
  printf '    {"name": "%s", "file": "%s", "bytes": %s, "sha256": "%s"}' \
    "$name" "$file" \
    "$(wc -c < "$DEST/$file" | tr -d ' ')" \
    "$(sha256sum "$DEST/$file" | cut -d' ' -f1)"
}

COMPONENTS=""
for pair in "database.sql:database" "dendrite.sql:homeserver" \
            "matrix_key.pem:matrixKey" "ipfs_data.tar.gz:files" "env.backup:settings"; do
  entry="$(component_json "${pair%%:*}" "${pair##*:}")"
  [ -n "$entry" ] || continue
  [ -n "$COMPONENTS" ] && COMPONENTS="$COMPONENTS,"$'\n'
  COMPONENTS="$COMPONENTS$entry"
done

cat > "$DEST/manifest.json" <<EOF
{
  "format": "sovbackup",
  "formatVersion": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "instance": {
    "id": "$INSTANCE_ID",
    "matrixServerName": "$SERVER_NAME",
    "name": $(json_string "$INSTANCE_NAME")
  },
  "versions": {
    "app": "${APP_VERSION:-unknown}",
    "protocol": { "major": 1, "minor": 0 },
    "schema": $(json_string "$SCHEMA")
  },
  "runtime": "docker",
  "components": [
$COMPONENTS
  ]
}
EOF

# --- one archive ------------------------------------------------------------

tar czf "$OUT_DIR/${NAME}.tar.gz" -C "$OUT_DIR" "$NAME"
rm -rf "$DEST"
chmod 600 "$OUT_DIR/${NAME}.tar.gz"

echo "$OUT_DIR/${NAME}.tar.gz"
