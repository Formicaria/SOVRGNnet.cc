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

cat > "$DEST/BACKUP_INFO.txt" <<EOF
SOVRGNnet backup
================
Taken:    $(date)
Install:  $RUNTIME
Host:     $(uname -srm)

What's inside
  database.sql        accounts, servers, channels, messages
  dendrite.sql        the homeserver's rooms and events
  matrix_key.pem      the homeserver's identity — without it this becomes a
                      different server to everyone it federates with
  ipfs_data.tar.gz    the actual bytes of every shared file
  env.backup          your secrets and settings — treat this as a password

To restore onto a fresh machine
  1. Install Docker
  2. Clone SOVRGNnet and put this backup in ./backups/
  3. ./scripts/restore.sh $BACKUP_NAME

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
