#!/usr/bin/env bash
#
# Save a complete copy of your SOVRGNnet: accounts, messages, shared files,
# and the Matrix homeserver's own database. One file you can copy anywhere.
#
#   ./sovrgnnet backup          (or: ./scripts/backup.sh)
#
# Restore it later with ./scripts/restore.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'

BACKUP_DIR="./backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_NAME="sovrgnnet_backup_${TIMESTAMP}"
DEST="$BACKUP_DIR/$BACKUP_NAME"

<<<<<<< HEAD
if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo -e "${RED}Docker Compose isn't installed.${NC}" >&2; exit 1
fi

[ -f .env ] || { echo -e "${RED}No .env found — run ./install.sh first.${NC}" >&2; exit 1; }

# Volume names are prefixed with the compose project name, which defaults to
# the directory name. Read it back rather than assuming.
PROJECT="$($DC config --format json 2>/dev/null | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)"
PROJECT="${PROJECT:-$(basename "$REPO_DIR" | tr '[:upper:]' '[:lower:]')}"

echo -e "${GREEN}Backing up SOVRGNnet${NC}"
echo -e "${DIM}This takes a minute. Nothing is interrupted — you can keep chatting.${NC}\n"

mkdir -p "$DEST"

# --- Postgres: accounts, servers, channels, messages, file metadata --------
echo -e "${YELLOW}Database...${NC}"
if ! $DC exec -T db pg_dump -U sovrgn -d sovrgnnet --clean --if-exists > "$DEST/database.sql" 2>/dev/null; then
  echo -e "${RED}Couldn't reach the database. Is it running? (./sovrgnnet status)${NC}" >&2
  rm -rf "$DEST"; exit 1
fi
echo -e "${GREEN}  ✓ $(wc -l < "$DEST/database.sql") lines${NC}"

# --- Matrix homeserver state (rooms, events, its own accounts) -------------
echo -e "${YELLOW}Chat history...${NC}"
docker run --rm \
  -v "${PROJECT}_matrix_data:/data:ro" \
  -v "$(pwd)/$DEST:/backup" \
  alpine tar czf /backup/matrix_data.tar.gz -C /data . 2>/dev/null \
  || echo -e "${RED}  ! Skipped (volume ${PROJECT}_matrix_data not found)${NC}"

# --- IPFS blocks: the actual bytes of every shared file --------------------
echo -e "${YELLOW}Shared files...${NC}"
docker run --rm \
  -v "${PROJECT}_ipfs_data:/data:ro" \
  -v "$(pwd)/$DEST:/backup" \
  alpine tar czf /backup/ipfs_data.tar.gz -C /data . 2>/dev/null \
  || echo -e "${RED}  ! Skipped (volume ${PROJECT}_ipfs_data not found)${NC}"

# --- Settings --------------------------------------------------------------
echo -e "${YELLOW}Settings...${NC}"
cp .env "$DEST/env.backup"
chmod 600 "$DEST/env.backup"

cat > "$DEST/BACKUP_INFO.txt" <<EOF
SOVRGNnet backup
================
Taken:    $(date)
Project:  $PROJECT
Host:     $(uname -srm)

What's inside
  database.sql        accounts, servers, channels, messages
  matrix_data.tar.gz  the Matrix homeserver's own store
  ipfs_data.tar.gz    the actual bytes of every shared file
  env.backup          your secrets and settings — treat this as a password

To restore onto a fresh machine
  1. Install Docker
  2. Clone SOVRGNnet and put this backup in ./backups/
  3. ./scripts/restore.sh $BACKUP_NAME

=======
# Same two shapes the control script knows about: Docker or native/LXC.
NATIVE_ENV="/etc/sovrgnnet/sovrgnnet.env"
if [ -f "$NATIVE_ENV" ]; then
  RUNTIME="native"
  ENV_FILE="$NATIVE_ENV"
elif [ -f .env ]; then
  RUNTIME="docker"
  ENV_FILE=".env"
  if docker compose version >/dev/null 2>&1; then
    DC="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    DC="docker-compose"
  else
    echo -e "${RED}Docker Compose isn't installed.${NC}" >&2; exit 1
  fi
else
  echo -e "${RED}No settings found — run an installer first.${NC}" >&2; exit 1
fi

echo -e "${GREEN}Backing up SOVRGNnet${NC} ${DIM}($RUNTIME)${NC}"
echo -e "${DIM}This takes a minute. Nothing is interrupted — you can keep chatting.${NC}\n"

mkdir -p "$DEST"

if [ "$RUNTIME" = "native" ]; then
  # ---------------------------------------------------------- native paths
  echo -e "${YELLOW}Database...${NC}"
  if ! su - postgres -c "pg_dump -d sovrgnnet --clean --if-exists" > "$DEST/database.sql" 2>/dev/null; then
    echo -e "${RED}Couldn't reach the database. Is it running? (sovrgnnet status)${NC}" >&2
    rm -rf "$DEST"; exit 1
  fi
  echo -e "${GREEN}  ✓ $(wc -l < "$DEST/database.sql") lines${NC}"

  # The homeserver's own database — rooms, events, everything Matrix knows.
  echo -e "${YELLOW}Chat history...${NC}"
  if su - postgres -c "pg_dump -d dendrite --clean --if-exists" > "$DEST/dendrite.sql" 2>/dev/null; then
    echo -e "${GREEN}  ✓ $(wc -l < "$DEST/dendrite.sql") lines${NC}"
  else
    rm -f "$DEST/dendrite.sql"
    echo -e "${DIM}  - no homeserver database yet${NC}"
  fi

  # Chat history lives in the `dendrite` database now, not a separate store —
  # so it comes out with the database dump below rather than as a tarball.
  # The signing key still needs saving: it is the server's Matrix identity,
  # and losing it makes this a different server to everyone it federates with.
  echo -e "${YELLOW}Homeserver identity...${NC}"
  if [ -f /etc/dendrite/matrix_key.pem ]; then
    cp /etc/dendrite/matrix_key.pem "$DEST/matrix_key.pem"
    chmod 600 "$DEST/matrix_key.pem"
    echo -e "${GREEN}  ✓ signing key saved${NC}"
  else
    echo -e "${DIM}  - no signing key at /etc/dendrite${NC}"
  fi

  echo -e "${YELLOW}Shared files...${NC}"
  if [ -d /var/lib/ipfs ]; then
    tar czf "$DEST/ipfs_data.tar.gz" -C /var/lib/ipfs . 2>/dev/null
    echo -e "${GREEN}  ✓ archived${NC}"
  else
    echo -e "${DIM}  - nothing at /var/lib/ipfs${NC}"
  fi
else
  # ---------------------------------------------------------- docker volumes
  # Volume names carry the compose project prefix, which defaults to the
  # directory name. Read it back rather than assuming.
  PROJECT="$($DC config --format json 2>/dev/null | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)"
  PROJECT="${PROJECT:-$(basename "$REPO_DIR" | tr '[:upper:]' '[:lower:]')}"

  echo -e "${YELLOW}Database...${NC}"
  if ! $DC exec -T db pg_dump -U sovrgn -d sovrgnnet --clean --if-exists > "$DEST/database.sql" 2>/dev/null; then
    echo -e "${RED}Couldn't reach the database. Is it running? (./sovrgnnet status)${NC}" >&2
    rm -rf "$DEST"; exit 1
  fi
  echo -e "${GREEN}  ✓ $(wc -l < "$DEST/database.sql") lines${NC}"

  # Chat history is in the `dendrite` database, dumped alongside the app's.
  echo -e "${YELLOW}Chat history...${NC}"
  if $DC exec -T db pg_dump -U sovrgn -d dendrite --clean --if-exists > "$DEST/dendrite.sql" 2>/dev/null; then
    echo -e "${GREEN}  ✓ $(wc -l < "$DEST/dendrite.sql") lines${NC}"
  else
    rm -f "$DEST/dendrite.sql"
    echo -e "${DIM}  - no homeserver database yet${NC}"
  fi

  # The signing key is the server's Matrix identity — losing it makes this a
  # different server to everyone it has ever federated with.
  if [ -f dendrite/matrix_key.pem ]; then
    cp dendrite/matrix_key.pem "$DEST/matrix_key.pem"
    chmod 600 "$DEST/matrix_key.pem"
    echo -e "${GREEN}  ✓ signing key saved${NC}"
  fi

  echo -e "${YELLOW}Shared files...${NC}"
  docker run --rm \
    -v "${PROJECT}_ipfs_data:/data:ro" \
    -v "$(pwd)/$DEST:/backup" \
    alpine tar czf /backup/ipfs_data.tar.gz -C /data . 2>/dev/null \
    || echo -e "${RED}  ! Skipped (volume ${PROJECT}_ipfs_data not found)${NC}"
fi

# --- Settings --------------------------------------------------------------
echo -e "${YELLOW}Settings...${NC}"
cp "$ENV_FILE" "$DEST/env.backup"
chmod 600 "$DEST/env.backup"
echo "$RUNTIME" > "$DEST/RUNTIME"

# --- Manifest --------------------------------------------------------------
# The machine-readable half. Without it a restore is a leap of faith: you learn
# whether the archive was complete, uncorrupted, and from the right server only
# after it has overwritten the machine. With it, restore.sh can refuse first.
#
# The format is defined in shared/backup.ts, which is normative and tested.
# This writes it; scripts/verify-backup.sh reads it.
echo -e "${YELLOW}Manifest...${NC}"

# Strip a surrounding pair of quotes, not every quote in the value — an
# instance called "Zach's box" should not come back as "Zachs box".
read_env() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1 | tr -d '\r' \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Anything landing in the manifest has to survive being read back as JSON.
json_string() {
  [ -n "$1" ] || { printf 'null'; return; }
  printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g')"
}

SERVER_NAME="$(read_env MATRIX_SERVER_NAME)"
SERVER_NAME="${SERVER_NAME:-unconfigured}"
INSTANCE_NAME="$(read_env INSTANCE_NAME)"

# Must match instanceId() in server/instance.ts — same seed, same truncation.
INSTANCE_ID="$(printf 'sovrgnnet:instance:%s' "$SERVER_NAME" | sha256sum | cut -c1-16)"

APP_VERSION="$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$REPO_DIR/package.json" | head -1)"
APP_VERSION="${APP_VERSION:-unknown}"

# The migration the database sits at. Restoring onto a build that doesn't know
# this tag means the backup came from the future — migrations only run forward.
SCHEMA="$(grep -o '"tag" *: *"[^"]*"' "$REPO_DIR/drizzle/meta/_journal.json" 2>/dev/null \
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

NAME_JSON="$(json_string "$INSTANCE_NAME")"
SCHEMA_JSON="$(json_string "$SCHEMA")"

cat > "$DEST/manifest.json" <<EOF
{
  "format": "sovbackup",
  "formatVersion": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "instance": {
    "id": "$INSTANCE_ID",
    "matrixServerName": "$SERVER_NAME",
    "name": $NAME_JSON
  },
  "versions": {
    "app": "$APP_VERSION",
    "protocol": { "major": 1, "minor": 0 },
    "schema": $SCHEMA_JSON
  },
  "runtime": "$RUNTIME",
  "components": [
$COMPONENTS
  ]
}
EOF
echo -e "${GREEN}  ✓ $SERVER_NAME · v$APP_VERSION · ${SCHEMA:-no schema}${NC}"

cat > "$DEST/BACKUP_INFO.txt" <<EOF
SOVRGNnet backup
================
Taken:    $(date)
Install:  $RUNTIME
Host:     $(uname -srm)

What's inside
  manifest.json       what this backup is, and a checksum for every part
  database.sql        accounts, communities, channels, messages
  dendrite.sql        the homeserver's rooms and events
  matrix_key.pem      the homeserver's identity — without it this becomes a
                      different server to everyone it federates with
  ipfs_data.tar.gz    the actual bytes of every shared file
  env.backup          your secrets and settings — treat this as a password

This instance
  Matrix server name  $SERVER_NAME
  Instance id         $INSTANCE_ID
  App version         $APP_VERSION
  Schema              ${SCHEMA:-none}

Restoring onto a different machine keeps working **only if that machine uses
the same MATRIX_SERVER_NAME**. Matrix IDs embed it permanently; change it and
every room and account detaches from its history. restore.sh checks this and
refuses rather than letting it happen quietly.

To restore onto a fresh machine
  1. Install Docker (or use scripts/install-lxc.sh for a native install)
  2. Clone SOVRGNnet and put this backup in ./backups/
  3. ./scripts/restore.sh $BACKUP_NAME

To check a backup without restoring it
  ./scripts/verify-backup.sh $BACKUP_NAME

>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
Keep this file somewhere other than the machine it came from.
EOF

# --- One archive -----------------------------------------------------------
echo -e "${YELLOW}Packing...${NC}"
tar czf "$BACKUP_DIR/${BACKUP_NAME}.tar.gz" -C "$BACKUP_DIR" "$BACKUP_NAME"
rm -rf "$DEST"
chmod 600 "$BACKUP_DIR/${BACKUP_NAME}.tar.gz"

SIZE=$(du -h "$BACKUP_DIR/${BACKUP_NAME}.tar.gz" | cut -f1)

echo ""
echo -e "${GREEN}Done — $SIZE${NC}"
echo -e "  $(pwd)/$BACKUP_DIR/${BACKUP_NAME}.tar.gz"
echo ""
echo -e "${DIM}That file contains your passwords. Copy it somewhere safe and private —${NC}"
echo -e "${DIM}an external drive or another computer. A backup on the same machine${NC}"
echo -e "${DIM}doesn't help when that machine is the thing that fails.${NC}"
echo ""
