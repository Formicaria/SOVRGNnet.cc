#!/usr/bin/env bash
#
# Put a SOVRGNnet backup back — onto this machine or a brand new one.
#
#   ./scripts/restore.sh                              pick from a list
#   ./scripts/restore.sh sovrgnnet_backup_20260815_120000
#
# This replaces everything currently on this instance. You'll be asked to
# confirm before anything is overwritten.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
BACKUP_DIR="./backups"

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DC="docker-compose"
else
  echo -e "${RED}Docker Compose isn't installed.${NC}" >&2; exit 1
fi

# ------------------------------------------------------------ pick a backup

BACKUP_SOURCE="${1:-}"

if [ -z "$BACKUP_SOURCE" ]; then
  mapfile -t FOUND < <(ls -1t "$BACKUP_DIR"/*.tar.gz 2>/dev/null || true)
  if [ "${#FOUND[@]}" -eq 0 ]; then
    echo -e "${RED}No backups found in $BACKUP_DIR${NC}"
    echo -e "${DIM}Copy your backup file there first, then run this again.${NC}"
    exit 1
  fi
  echo -e "${BOLD}Which backup?${NC}\n"
  for i in "${!FOUND[@]}"; do
    printf '    %s%d%s  %s  %s(%s)%s\n' "$BOLD" "$((i + 1))" "$NC" \
      "$(basename "${FOUND[$i]}")" "$DIM" "$(du -h "${FOUND[$i]}" | cut -f1)" "$NC"
  done
  echo ""
  read -r -p "  Pick a number [1]: " choice </dev/tty
  choice="${choice:-1}"
  BACKUP_SOURCE="${FOUND[$((choice - 1))]:-}"
  [ -n "$BACKUP_SOURCE" ] || { echo -e "${RED}That wasn't one of the options.${NC}"; exit 1; }
fi

# Accept a bare name, a path, or an archive.
if [ ! -e "$BACKUP_SOURCE" ] && [ -e "$BACKUP_DIR/$BACKUP_SOURCE.tar.gz" ]; then
  BACKUP_SOURCE="$BACKUP_DIR/$BACKUP_SOURCE.tar.gz"
fi
[ -e "$BACKUP_SOURCE" ] || { echo -e "${RED}Can't find $BACKUP_SOURCE${NC}"; exit 1; }

if [[ "$BACKUP_SOURCE" == *.tar.gz ]]; then
  BACKUP_NAME="$(basename "$BACKUP_SOURCE" .tar.gz)"
  mkdir -p "$BACKUP_DIR"
  tar xzf "$BACKUP_SOURCE" -C "$BACKUP_DIR"
  BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
  EXTRACTED=1
else
  BACKUP_PATH="$BACKUP_SOURCE"
  EXTRACTED=0
fi

[ -d "$BACKUP_PATH" ] || { echo -e "${RED}$BACKUP_PATH isn't a backup folder.${NC}"; exit 1; }

# ------------------------------------------------------------------ confirm

echo ""
[ -f "$BACKUP_PATH/BACKUP_INFO.txt" ] && sed -n '1,8p' "$BACKUP_PATH/BACKUP_INFO.txt"
echo ""
echo -e "${YELLOW}${BOLD}This replaces everything on this instance${NC}"
echo -e "${DIM}Current accounts, messages, and files will be overwritten by the backup.${NC}"
echo ""
read -r -p "  Type 'restore' to continue: " answer </dev/tty
[ "$answer" = "restore" ] || { echo "Cancelled — nothing changed."; exit 0; }

PROJECT="$($DC config --format json 2>/dev/null | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)"
PROJECT="${PROJECT:-$(basename "$REPO_DIR" | tr '[:upper:]' '[:lower:]')}"

# ------------------------------------------------------------------- settings

if [ -f "$BACKUP_PATH/env.backup" ]; then
  echo -e "\n${YELLOW}Settings...${NC}"
  [ -f .env ] && cp .env ".env.before-restore.$(date +%Y%m%d%H%M%S)"
  cp "$BACKUP_PATH/env.backup" .env
  chmod 600 .env
  echo -e "${GREEN}  ✓ restored (your previous .env was kept alongside)${NC}"
fi

# Stop the app so nothing writes while we swap the data underneath it.
echo -e "\n${YELLOW}Pausing services...${NC}"
$DC stop app >/dev/null 2>&1 || true

# ------------------------------------------------------------------- volumes

restore_volume() {
  local archive="$1" volume="$2" label="$3"
  [ -f "$archive" ] || { echo -e "${DIM}  - no $label in this backup${NC}"; return; }
  echo -e "${YELLOW}$label...${NC}"
  $DC stop "$4" >/dev/null 2>&1 || true
  docker volume create "$volume" >/dev/null
  docker run --rm \
    -v "$volume:/data" \
    -v "$(pwd)/$(dirname "$archive"):/backup:ro" \
    alpine sh -c "rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/$(basename "$archive") -C /data"
  echo -e "${GREEN}  ✓ restored${NC}"
}

restore_volume "$BACKUP_PATH/matrix_data.tar.gz" "${PROJECT}_matrix_data" "Chat history" "matrix"
restore_volume "$BACKUP_PATH/ipfs_data.tar.gz"   "${PROJECT}_ipfs_data"   "Shared files" "ipfs"

# ------------------------------------------------------------------ database

if [ -f "$BACKUP_PATH/database.sql" ]; then
  echo -e "${YELLOW}Database...${NC}"
  $DC up -d db >/dev/null
  for _ in $(seq 1 30); do
    $DC exec -T db pg_isready -U sovrgn -d sovrgnnet >/dev/null 2>&1 && break
    sleep 2
  done
  $DC exec -T db psql -U sovrgn -d sovrgnnet -v ON_ERROR_STOP=0 < "$BACKUP_PATH/database.sql" >/dev/null
  echo -e "${GREEN}  ✓ restored${NC}"
fi

# --------------------------------------------------------------------- start

echo -e "\n${YELLOW}Starting back up...${NC}"
ACCESS_MODE="$(sed -n 's/^SOVRGNNET_ACCESS_MODE=//p' .env 2>/dev/null | tail -1)"
case "$ACCESS_MODE" in
  quick)  PROFILES="--profile quick" ;;
  tunnel) PROFILES="--profile tunnel" ;;
  proxy)  PROFILES="--profile proxy" ;;
  *)      PROFILES="" ;;
esac
# shellcheck disable=SC2086
$DC $PROFILES up -d

[ "$EXTRACTED" -eq 1 ] && rm -rf "$BACKUP_PATH"

echo ""
echo -e "${GREEN}${BOLD}Restored.${NC}"
echo -e "${DIM}Check it with: ./sovrgnnet status${NC}"
echo ""
