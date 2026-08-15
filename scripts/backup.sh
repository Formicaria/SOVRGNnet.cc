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
