#!/usr/bin/env bash
#
# Put a SOVRGNnet backup back — onto this machine or a brand new one.
#
#   ./scripts/restore.sh                              pick from a list
#   ./scripts/restore.sh sovrgnnet_backup_20260815_120000
#   ./scripts/restore.sh --force <name>               skip the safety check
#
# This replaces everything currently on this instance. The backup is verified
# before anything is touched, and you'll be asked to confirm.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
BACKUP_DIR="./backups"

FORCE=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done

# Same two shapes as backup.sh. Restoring a native backup used to fail here
# because this script assumed Docker.
NATIVE_ENV="/etc/sovrgnnet/sovrgnnet.env"
if [ -f "$NATIVE_ENV" ]; then
  RUNTIME="native"
  ENV_FILE="$NATIVE_ENV"
elif docker compose version >/dev/null 2>&1; then
  RUNTIME="docker"; DC="docker compose"; ENV_FILE=".env"
elif command -v docker-compose >/dev/null 2>&1; then
  RUNTIME="docker"; DC="docker-compose"; ENV_FILE=".env"
else
  echo -e "${RED}Neither a native install nor Docker Compose found.${NC}" >&2
  echo -e "${DIM}Run an installer first, then restore into it.${NC}" >&2
  exit 1
fi

# ------------------------------------------------------------ pick a backup

BACKUP_SOURCE="${ARGS[0]:-}"

if [ -z "$BACKUP_SOURCE" ]; then
  mapfile -t FOUND < <(ls -1t "$BACKUP_DIR"/*.tar.gz "$BACKUP_DIR"/*.sovbackup "$BACKUP_DIR"/*.enc 2>/dev/null || true)
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

# Accept a bare name, a path, or an archive in any extension.
for candidate in "$BACKUP_SOURCE" "$BACKUP_DIR/$BACKUP_SOURCE" \
                 "$BACKUP_DIR/$BACKUP_SOURCE.tar.gz" "$BACKUP_DIR/$BACKUP_SOURCE.sovbackup" \
                 "$BACKUP_DIR/$BACKUP_SOURCE.tar.gz.enc"; do
  [ -e "$candidate" ] && { BACKUP_SOURCE="$candidate"; break; }
done
[ -e "$BACKUP_SOURCE" ] || { echo -e "${RED}Can't find $BACKUP_SOURCE${NC}"; exit 1; }

# --- Encrypted backups -------------------------------------------------------
# Detected by content, not filename — a renamed envelope still opens. The
# decrypted archive lands next to the original with restrictive permissions
# and is removed after extraction.
DECRYPTED=""
if [ -f "$BACKUP_SOURCE" ] && npx tsx scripts/backup-crypt.ts check "$BACKUP_SOURCE" 2>/dev/null; then
  echo -e "${BOLD}This backup is encrypted.${NC}"
  if [ -z "${SOVRGN_BACKUP_PASSPHRASE:-}" ]; then
    read -r -s -p "  Passphrase: " SOVRGN_BACKUP_PASSPHRASE </dev/tty
    echo ""
    export SOVRGN_BACKUP_PASSPHRASE
  fi
  DECRYPTED="${BACKUP_SOURCE%.enc}"
  DECRYPTED="${DECRYPTED%.tar.gz}.decrypted.tar.gz"
  if ! npx tsx scripts/backup-crypt.ts decrypt "$BACKUP_SOURCE" "$DECRYPTED"; then
    echo -e "${RED}Couldn't decrypt — wrong passphrase, or the file is damaged.${NC}"
    exit 1
  fi
  chmod 600 "$DECRYPTED"
  BACKUP_SOURCE="$DECRYPTED"
fi

EXTRACTED=0
if [ -f "$BACKUP_SOURCE" ]; then
  BACKUP_NAME="$(basename "$BACKUP_SOURCE" | sed 's/\.decrypted\.tar\.gz$//; s/\.tar\.gz$//; s/\.sovbackup$//')"
  mkdir -p "$BACKUP_DIR"
  tar xzf "$BACKUP_SOURCE" -C "$BACKUP_DIR"
  BACKUP_PATH="$BACKUP_DIR/$BACKUP_NAME"
  EXTRACTED=1
  [ -n "$DECRYPTED" ] && rm -f "$DECRYPTED"
else
  BACKUP_PATH="$BACKUP_SOURCE"
fi

[ -d "$BACKUP_PATH" ] || { echo -e "${RED}$BACKUP_PATH isn't a backup folder.${NC}"; exit 1; }

# ------------------------------------------------------------------- verify
#
# Before anything is overwritten. A restore that fails halfway is worse than
# one that refuses to start, because it looks like it worked.

echo ""
if [ "$FORCE" -eq 1 ]; then
  echo -e "${YELLOW}Skipping verification (--force).${NC}"
  echo -e "${DIM}You are choosing to restore a backup nobody has checked.${NC}\n"
elif ! bash "$REPO_DIR/scripts/verify-backup.sh" "$BACKUP_PATH"; then
  [ "$EXTRACTED" -eq 1 ] && rm -rf "$BACKUP_PATH"
  echo -e "${DIM}Nothing was changed. Fix the problem above, or use --force if you${NC}"
  echo -e "${DIM}understand the consequences and want to restore anyway.${NC}\n"
  exit 1
fi

# ------------------------------------------------------------------ confirm

echo -e "${YELLOW}${BOLD}This replaces everything on this instance${NC}"
echo -e "${DIM}Current accounts, messages, and files will be overwritten by the backup.${NC}"
echo ""
read -r -p "  Type 'restore' to continue: " answer </dev/tty
[ "$answer" = "restore" ] || { echo "Cancelled — nothing changed."; \
  [ "$EXTRACTED" -eq 1 ] && rm -rf "$BACKUP_PATH"; exit 0; }

# ------------------------------------------------------------------- settings

if [ -f "$BACKUP_PATH/env.backup" ]; then
  echo -e "\n${YELLOW}Settings...${NC}"
  [ -f "$ENV_FILE" ] && cp "$ENV_FILE" "$ENV_FILE.before-restore.$(date +%Y%m%d%H%M%S)"
  install -m 600 "$BACKUP_PATH/env.backup" "$ENV_FILE"
  echo -e "${GREEN}  ✓ restored (your previous settings were kept alongside)${NC}"
fi

if [ "$RUNTIME" = "native" ]; then
  # =========================================================== native / LXC

  echo -e "\n${YELLOW}Pausing services...${NC}"
  systemctl stop sovrgnnet dendrite >/dev/null 2>&1 || true

  echo -e "${YELLOW}Database...${NC}"
  systemctl start postgresql >/dev/null 2>&1 || true
  for _ in $(seq 1 30); do
    su - postgres -c "pg_isready -d sovrgnnet" >/dev/null 2>&1 && break
    sleep 2
  done
  su - postgres -c "psql -d sovrgnnet -v ON_ERROR_STOP=0" < "$BACKUP_PATH/database.sql" >/dev/null
  echo -e "${GREEN}  ✓ restored${NC}"

  # This used to be skipped entirely, which quietly discarded every message.
  if [ -f "$BACKUP_PATH/dendrite.sql" ]; then
    echo -e "${YELLOW}Chat history...${NC}"
    su - postgres -c "psql -d dendrite -v ON_ERROR_STOP=0" < "$BACKUP_PATH/dendrite.sql" >/dev/null
    echo -e "${GREEN}  ✓ restored${NC}"
  else
    echo -e "${DIM}  - no chat history in this backup${NC}"
  fi

  if [ -f "$BACKUP_PATH/matrix_key.pem" ]; then
    echo -e "${YELLOW}Homeserver identity...${NC}"
    mkdir -p /etc/dendrite
    install -m 600 "$BACKUP_PATH/matrix_key.pem" /etc/dendrite/matrix_key.pem
    chown dendrite:dendrite /etc/dendrite/matrix_key.pem 2>/dev/null || true
    echo -e "${GREEN}  ✓ signing key restored${NC}"
  else
    echo -e "${YELLOW}  ! No signing key — this becomes a different server to anyone it federates with.${NC}"
  fi

  if [ -f "$BACKUP_PATH/ipfs_data.tar.gz" ]; then
    echo -e "${YELLOW}Shared files...${NC}"
    systemctl stop ipfs >/dev/null 2>&1 || true
    mkdir -p /var/lib/ipfs
    rm -rf /var/lib/ipfs/* /var/lib/ipfs/..?* 2>/dev/null || true
    tar xzf "$BACKUP_PATH/ipfs_data.tar.gz" -C /var/lib/ipfs
    chown -R ipfs:ipfs /var/lib/ipfs 2>/dev/null || true
    echo -e "${GREEN}  ✓ restored${NC}"
  fi

  echo -e "\n${YELLOW}Starting back up...${NC}"
  systemctl start postgresql ipfs dendrite sovrgnnet >/dev/null 2>&1 || true

else
  # ================================================================= docker

  PROJECT="$($DC config --format json 2>/dev/null | sed -n 's/.*"name":"\([^"]*\)".*/\1/p' | head -1)"
  PROJECT="${PROJECT:-$(basename "$REPO_DIR" | tr '[:upper:]' '[:lower:]')}"

  echo -e "\n${YELLOW}Pausing services...${NC}"
  $DC stop app matrix >/dev/null 2>&1 || true

  # The signing key is a bind mount, so it goes back before the homeserver
  # starts and generates itself a new identity.
  if [ -f "$BACKUP_PATH/matrix_key.pem" ]; then
    echo -e "${YELLOW}Homeserver identity...${NC}"
    mkdir -p dendrite
    install -m 600 "$BACKUP_PATH/matrix_key.pem" dendrite/matrix_key.pem
    echo -e "${GREEN}  ✓ signing key restored${NC}"
  else
    echo -e "${YELLOW}  ! No signing key — this becomes a different server to anyone it federates with.${NC}"
  fi

  if [ -f "$BACKUP_PATH/ipfs_data.tar.gz" ]; then
    echo -e "${YELLOW}Shared files...${NC}"
    $DC stop ipfs >/dev/null 2>&1 || true
    docker volume create "${PROJECT}_ipfs_data" >/dev/null
    docker run --rm \
      -v "${PROJECT}_ipfs_data:/data" \
      -v "$(pwd)/$BACKUP_PATH:/backup:ro" \
      alpine sh -c "rm -rf /data/* /data/..?* 2>/dev/null; tar xzf /backup/ipfs_data.tar.gz -C /data"
    echo -e "${GREEN}  ✓ restored${NC}"
  else
    echo -e "${DIM}  - no shared files in this backup${NC}"
  fi

  echo -e "${YELLOW}Database...${NC}"
  $DC up -d db >/dev/null
  for _ in $(seq 1 30); do
    $DC exec -T db pg_isready -U sovrgn -d sovrgnnet >/dev/null 2>&1 && break
    sleep 2
  done
  $DC exec -T db psql -U sovrgn -d sovrgnnet -v ON_ERROR_STOP=0 < "$BACKUP_PATH/database.sql" >/dev/null
  echo -e "${GREEN}  ✓ restored${NC}"

  # Dendrite keeps rooms and events in its own database. Restoring the app's
  # database without this one leaves every channel pointing at a room the
  # homeserver has never heard of — structure intact, history gone.
  if [ -f "$BACKUP_PATH/dendrite.sql" ]; then
    echo -e "${YELLOW}Chat history...${NC}"
    $DC exec -T db psql -U sovrgn -d dendrite -v ON_ERROR_STOP=0 < "$BACKUP_PATH/dendrite.sql" >/dev/null \
      && echo -e "${GREEN}  ✓ restored${NC}" \
      || echo -e "${YELLOW}  ! Couldn't restore chat history — check the dendrite database exists.${NC}"
  else
    echo -e "${DIM}  - no chat history in this backup${NC}"
  fi

  echo -e "\n${YELLOW}Starting back up...${NC}"
  ACCESS_MODE="$(sed -n 's/^SOVRGNNET_ACCESS_MODE=//p' "$ENV_FILE" 2>/dev/null | tail -1)"
  case "$ACCESS_MODE" in
    quick)  PROFILES="--profile quick" ;;
    tunnel) PROFILES="--profile tunnel" ;;
    proxy)  PROFILES="--profile proxy" ;;
    *)      PROFILES="" ;;
  esac
  # shellcheck disable=SC2086
  $DC $PROFILES up -d
fi

[ "$EXTRACTED" -eq 1 ] && rm -rf "$BACKUP_PATH"

echo ""
echo -e "${GREEN}${BOLD}Restored.${NC}"
echo -e "${DIM}Check it with: sovrgnnet status${NC}"
echo ""
