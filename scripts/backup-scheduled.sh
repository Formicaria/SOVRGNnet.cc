#!/usr/bin/env bash
#
# The unattended backup. Run by sovrgnnet-backup.timer, not by hand — for that
# use `sovrgnnet backup`, which is chattier and does not prune anything.
#
# Take a backup, prove it is readable, copy it somewhere else, throw away the
# oldest. In that order, because each step is only worth doing if the one
# before it worked.
#
#   SOVRGN_BACKUP_DEST         scp target for the copy, e.g. user@nas:/backups
#                              Unset means the archive never leaves this
#                              machine. See the warning below.
#   SOVRGN_BACKUP_KEEP         how many local archives to keep (default 7)
#   SOVRGN_BACKUP_PASSPHRASE   encrypts the archive, same as a manual backup
#
# Exits non-zero on any real failure so systemd records the unit as failed
# rather than the job disappearing into a log nobody opens.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

KEEP="${SOVRGN_BACKUP_KEEP:-7}"
DEST="${SOVRGN_BACKUP_DEST:-}"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] FAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------- take

log "starting"
./scripts/backup.sh >/dev/null || die "backup.sh did not complete"

# Newest archive, whatever extension it ended up with (.tar.gz or .tar.gz.enc).
ARCHIVE="$(ls -1t backups/sovrgnnet_backup_*.tar.gz* 2>/dev/null | head -1 || true)"
[ -n "$ARCHIVE" ] || die "backup.sh reported success but produced no archive"
log "took $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# -------------------------------------------------------------------- verify

# An unverified backup is a hope. This is cheap and catches the failures that
# actually happen — a truncated archive, a schema the current code can no
# longer read, a server name that will not match on restore.
#
# It is not a restore. It does not prove the data inside is correct, only that
# this file could be restored onto this machine. The only test of a backup is
# restoring it somewhere, and that belongs on a schedule of its own.
if [ -n "${SOVRGN_BACKUP_PASSPHRASE:-}" ]; then
  # verify-backup.sh reads the archive directly and cannot decrypt it. Skipping
  # the check is the honest outcome; pretending it passed is not.
  log "encrypted — skipping verification (verify-backup.sh cannot decrypt)"
else
  ./scripts/verify-backup.sh "$ARCHIVE" >/dev/null \
    || die "the archive did not verify — keeping it, but do not trust it"
  log "verified"
fi

# ---------------------------------------------------------------------- copy

if [ -n "$DEST" ]; then
  # BatchMode: never prompt. A scheduled job sitting on a passphrase prompt
  # looks identical to a slow one until the timer's next run collides with it.
  if scp -B -q -o ConnectTimeout=30 "$ARCHIVE" "$DEST/"; then
    log "copied to $DEST"
  else
    die "could not copy to $DEST — the local archive is fine, the offsite one does not exist"
  fi
else
  # Deliberately loud, and deliberately not fatal: refusing to back up at all
  # because there is nowhere to send it would be worse than a local copy.
  #
  # But say it plainly every single time. A backup on the machine it protects
  # covers exactly one failure — someone deleting the wrong thing — and none of
  # the ones that take the machine with it.
  log "WARNING: SOVRGN_BACKUP_DEST is unset, so this archive never left the box."
  log "WARNING: That is not a backup. It is a copy, on the disk it is protecting."
fi

# --------------------------------------------------------------------- prune

# Only after a successful copy. Pruning first would mean a bad run deletes
# history and replaces it with nothing.
mapfile -t OLD < <(ls -1t backups/sovrgnnet_backup_*.tar.gz* 2>/dev/null | tail -n +"$((KEEP + 1))")
if [ "${#OLD[@]}" -gt 0 ]; then
  for old in "${OLD[@]}"; do
    rm -f "$old"
    log "pruned $(basename "$old")"
  done
fi

log "done — $(ls -1 backups/sovrgnnet_backup_*.tar.gz* 2>/dev/null | wc -l) archive(s) kept"
