#!/usr/bin/env bash
#
# Check a backup without restoring it.
#
#   ./scripts/verify-backup.sh                          pick from a list
#   ./scripts/verify-backup.sh sovrgnnet_backup_20260815_120000
#   ./scripts/verify-backup.sh /path/to/backup.tar.gz
#
# Answers one question: if I restore this onto this machine, do I get a working
# instance? Exits 0 for yes, 1 for no. Warnings don't fail it.
#
# The rules live in shared/backup.ts, which is the normative definition and has
# tests. This implements the same rules in bash, because the machine you are
# restoring onto may not have a working application on it yet — which is
# usually the entire reason you are restoring.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
BACKUP_DIR="./backups"

SUPPORTED_FORMAT_VERSION=1

FATAL=0
WARN=0

fatal() { echo -e "  ${RED}✗${NC} $1"; FATAL=$((FATAL + 1)); }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; WARN=$((WARN + 1)); }
ok()    { echo -e "  ${GREEN}✓${NC} $1"; }

# ------------------------------------------------------------ find the backup

SOURCE="${1:-}"

if [ -z "$SOURCE" ]; then
  mapfile -t FOUND < <(ls -1t "$BACKUP_DIR"/*.tar.gz "$BACKUP_DIR"/*.sovbackup 2>/dev/null || true)
  [ "${#FOUND[@]}" -gt 0 ] || { echo -e "${RED}No backups in $BACKUP_DIR${NC}"; exit 1; }
  SOURCE="${FOUND[0]}"
  echo -e "${DIM}Checking the most recent: $(basename "$SOURCE")${NC}\n"
fi

for candidate in "$SOURCE" "$BACKUP_DIR/$SOURCE" "$BACKUP_DIR/$SOURCE.tar.gz" "$BACKUP_DIR/$SOURCE.sovbackup"; do
  [ -e "$candidate" ] && { SOURCE="$candidate"; break; }
done
[ -e "$SOURCE" ] || { echo -e "${RED}Can't find $SOURCE${NC}"; exit 1; }

CLEANUP=""
if [ -f "$SOURCE" ]; then
  DIR="$(mktemp -d)"
  CLEANUP="$DIR"
  tar xzf "$SOURCE" -C "$DIR" 2>/dev/null || { echo -e "${RED}Not a readable archive.${NC}"; exit 1; }
  # One directory in, or files at the root — accept both.
  inner="$(find "$DIR" -maxdepth 1 -mindepth 1 -type d | head -1)"
  [ -n "$inner" ] && [ ! -f "$DIR/manifest.json" ] && DIR="$inner"
else
  DIR="$SOURCE"
fi
trap '[ -n "$CLEANUP" ] && rm -rf "$CLEANUP"' EXIT

echo -e "${BOLD}$(basename "$SOURCE")${NC}\n"

# ------------------------------------------------------------------ manifest

# Field extraction without jq, which isn't installed on a bare Debian box and
# shouldn't be a prerequisite for getting your data back.
field() { grep -o "\"$1\" *: *\"[^\"]*\"" "$DIR/manifest.json" 2>/dev/null | head -1 | sed 's/.*: *"\(.*\)"$/\1/'; }
number() { grep -o "\"$1\" *: *[0-9]*" "$DIR/manifest.json" 2>/dev/null | head -1 | grep -o '[0-9]*$'; }

if [ ! -f "$DIR/manifest.json" ]; then
  warn "No manifest — this backup predates the .sovbackup format."
  echo -e "     ${DIM}It can still be restored, but nothing about it can be verified:${NC}"
  echo -e "     ${DIM}not its origin, not its completeness, not whether it is intact.${NC}"
  [ -f "$DIR/database.sql" ] || fatal "No database.sql. There is no instance in here."
  [ -f "$DIR/database.sql" ] && ok "database.sql present"
  echo ""
  [ "$FATAL" -eq 0 ] && { echo -e "${YELLOW}Unverifiable, but restorable.${NC}\n"; exit 0; }
  echo -e "${RED}${BOLD}Do not restore this.${NC}\n"; exit 1
fi

FORMAT="$(field format)"
[ "$FORMAT" = "sovbackup" ] || fatal "Not a SOVRGNnet backup (format: ${FORMAT:-missing})."

FORMAT_VERSION="$(number formatVersion)"
FORMAT_VERSION="${FORMAT_VERSION:-0}"
if [ "$FORMAT_VERSION" -gt "$SUPPORTED_FORMAT_VERSION" ]; then
  fatal "Format version $FORMAT_VERSION; this build understands up to $SUPPORTED_FORMAT_VERSION. Update SOVRGNnet, then restore."
fi

BACKUP_SERVER="$(field matrixServerName)"
BACKUP_APP="$(field app)"
BACKUP_SCHEMA="$(field schema)"

echo -e "${DIM}  from   ${NC}${BACKUP_SERVER:-unknown}"
echo -e "${DIM}  taken  ${NC}$(field createdAt)"
echo -e "${DIM}  version${NC} ${BACKUP_APP:-unknown} · schema ${BACKUP_SCHEMA:-none}"
echo ""

# ------------------------------------------------------- against this machine

TARGET_ENV=""
for f in /etc/sovrgnnet/sovrgnnet.env .env; do [ -f "$f" ] && { TARGET_ENV="$f"; break; }; done

if [ -n "$TARGET_ENV" ]; then
  TARGET_SERVER="$(sed -n 's/^MATRIX_SERVER_NAME=//p' "$TARGET_ENV" | tail -1 | tr -d '"'\''\r')"
  if [ -n "$TARGET_SERVER" ] && [ -n "$BACKUP_SERVER" ] && [ "$TARGET_SERVER" != "$BACKUP_SERVER" ]; then
    fatal "This backup is from \"$BACKUP_SERVER\" but this machine is \"$TARGET_SERVER\"."
    echo -e "     ${DIM}Matrix IDs embed the server name permanently. Restoring would detach${NC}"
    echo -e "     ${DIM}every room and account from its history — silently.${NC}"
    echo -e "     ${DIM}Set MATRIX_SERVER_NAME=$BACKUP_SERVER and run this again.${NC}"
  elif [ -n "$TARGET_SERVER" ]; then
    ok "Server name matches this machine"
  fi
else
  ok "Fresh machine — nothing to conflict with"
fi

# Migrations only run forward, so a schema this build has never heard of means
# the backup came from a newer version.
if [ -n "$BACKUP_SCHEMA" ] && [ -f drizzle/meta/_journal.json ]; then
  if grep -q "\"$BACKUP_SCHEMA\"" drizzle/meta/_journal.json; then
    LATEST="$(grep -o '"tag" *: *"[^"]*"' drizzle/meta/_journal.json | tail -1 | sed 's/.*"\([^"]*\)"$/\1/')"
    if [ "$LATEST" = "$BACKUP_SCHEMA" ]; then
      ok "Schema current"
    else
      warn "Backup is at $BACKUP_SCHEMA; this build is at $LATEST. Migrations run at startup."
    fi
  else
    fatal "Schema \"$BACKUP_SCHEMA\" is unknown to this build — the backup is newer. Update SOVRGNnet first."
  fi
fi

# ----------------------------------------------------------------- integrity

echo ""

# One flattened copy, so every check below is indifferent to how the manifest
# was formatted.
COMPACT="$(tr -d '\n\r' < "$DIR/manifest.json")"
declares() { printf '%s' "$COMPACT" | grep -q "\"file\" *: *\"$1\""; }

COMPONENT_COUNT=0
while IFS='|' read -r file bytes sha; do
  [ -n "$file" ] || continue
  COMPONENT_COUNT=$((COMPONENT_COUNT + 1))

  if [ ! -f "$DIR/$file" ]; then
    if [ "$file" = "database.sql" ]; then
      fatal "$file is in the manifest but missing from the archive."
    else
      warn "$file is in the manifest but missing from the archive."
    fi
    continue
  fi

  actual_sha="$(sha256sum "$DIR/$file" | cut -d' ' -f1)"
  actual_bytes="$(wc -c < "$DIR/$file" | tr -d ' ')"

  if [ "$actual_sha" != "$sha" ]; then
    fatal "$file is corrupt or was modified — checksum does not match."
  elif [ "$actual_bytes" != "$bytes" ]; then
    warn "$file is $actual_bytes bytes; the manifest says $bytes."
  else
    ok "$(printf '%-18s %8s bytes' "$file" "$actual_bytes")"
  fi
# Collapse whitespace first: a manifest written by another implementation may
# pretty-print its components across several lines, and a checksum verifier
# that quietly finds nothing is worse than no verifier at all.
done < <(printf '%s' "$COMPACT" \
  | grep -o '{[^{}]*"file"[^{}]*}' \
  | sed 's/.*"file" *: *"\([^"]*\)".*"bytes" *: *\([0-9]*\).*"sha256" *: *"\([^"]*\)".*/\1|\2|\3/')

[ "$COMPONENT_COUNT" -gt 0 ] || fatal "The manifest lists no components at all."
declares "database.sql" || fatal "No database in this backup. There is no instance to restore."
declares "matrix_key.pem" \
  || warn "No signing key. The restored instance becomes a different server to anyone it has federated with."
declares "dendrite.sql" \
  || warn "No homeserver database. Structure survives; chat history will be empty."

# ------------------------------------------------------------------- verdict

echo ""
if [ "$FATAL" -gt 0 ]; then
  echo -e "${RED}${BOLD}Do not restore this backup.${NC} ${DIM}($FATAL blocking, $WARN warnings)${NC}"
  echo ""
  exit 1
fi

if [ "$WARN" -gt 0 ]; then
  echo -e "${GREEN}${BOLD}Safe to restore.${NC} ${DIM}($WARN warning$([ "$WARN" -ne 1 ] && echo s) above)${NC}"
else
  echo -e "${GREEN}${BOLD}Verified. Complete and intact.${NC}"
fi
echo ""
