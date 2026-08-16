# Backup, restore, and moving machines

The design test for this whole project is whether an operator can leave. Leaving
means taking your instance somewhere else — and a backup that only restores onto
the machine it came from isn't portability, it's a snapshot of a host you're
stuck with.

```bash
sovrgnnet backup             # take one
sovrgnnet verify             # check it, change nothing
sovrgnnet restore            # put it back
```

## What's in a backup

| File | Contains | Without it |
|---|---|---|
| `manifest.json` | What this backup is, checksum per component | Nothing can be verified |
| `database.sql` | Accounts, communities, channels, messages, roles | **Nothing to restore** |
| `dendrite.sql` | The homeserver's rooms and events | Structure survives, history empty |
| `matrix_key.pem` | The homeserver's Matrix identity | Becomes a *different server* to anyone it federates with |
| `ipfs_data.tar.gz` | The bytes of every shared file | File records survive, downloads fail |
| `env.backup` | Every secret and setting | Supply secrets again by hand |

Only `database.sql` is strictly required. The rest degrade the restore in ways
the verifier states explicitly rather than letting you discover later.

**A backup is password material.** It contains every message and every secret,
in plaintext. Archives are written `0600`; the tooling does not encrypt them,
which is a known gap. If one leaves your control, encrypt it first.

## The one rule about moving machines

**`MATRIX_SERVER_NAME` must be the same on the new machine.**

Matrix user and room IDs embed the server name permanently, at creation. Restore
a backup from `a.example` onto an instance calling itself `b.example` and every
room and account inside points at a server this one isn't. History detaches, and
it detaches silently — the instance starts, looks fine, and is wrong.

`verify` checks this and refuses. It's the single most valuable thing it does.

## Verifying before you restore

```bash
sovrgnnet verify                            # most recent
sovrgnnet verify sovrgnnet_backup_20260815_120000
./scripts/verify-backup.sh /mnt/usb/backup.tar.gz
```

Exit code 0 means restoring produces a working instance. 1 means it doesn't.
Warnings don't fail it — they tell you what you'll lose.

Fatal:

- Not a SOVRGNnet backup, or a format version this build doesn't understand
- The server name doesn't match this machine
- The schema is newer than this build (migrations only run forward — update first)
- A checksum doesn't match: the archive is corrupt or was modified
- No database

Warnings:

- No signing key, no homeserver database, or no shared files
- Schema older than this build (migrations run at startup)
- Protocol major version differs

`restore` runs `verify` itself before touching anything. `--force` skips it, and
exists for the case where you know the backup is imperfect and want it anyway.

## Moving to a new machine

```bash
# On the old machine
sovrgnnet backup
scp backups/sovrgnnet_backup_*.tar.gz you@newbox:~/

# On the new one
git clone https://github.com/Formicaria/SOVRGNnet.cc.git sovrgnnet && cd sovrgnnet
./install.sh                      # or scripts/install-lxc.sh
mkdir -p backups && mv ~/sovrgnnet_backup_*.tar.gz backups/

sovrgnnet verify                  # do this before restore, not after
sovrgnnet restore
```

`env.backup` carries `MATRIX_SERVER_NAME` across, so restoring the settings
usually satisfies the server-name rule by itself. If you deliberately changed
it, verify will tell you exactly what to set it back to.

Docker and native installs both work, and a backup taken on one restores onto
the other — `manifest.json` records which it came from, and `restore.sh`
detects which it's running on.

## The format

`.sovbackup` is a gzipped tar containing the files above plus `manifest.json`:

```json
{
  "format": "sovbackup",
  "formatVersion": 1,
  "createdAt": "2026-08-15T21:00:00Z",
  "instance": { "id": "98efa4ac7047ab2a", "matrixServerName": "sovrgnnet.cc", "name": "..." },
  "versions": { "app": "0.4.0", "protocol": { "major": 1, "minor": 0 }, "schema": "0005_fuzzy_kylun" },
  "runtime": "docker",
  "components": [
    { "name": "database", "file": "database.sql", "bytes": 4821003, "sha256": "..." }
  ]
}
```

`instance.id` is derived by hashing the Matrix server name — the same derivation
`server/instance.ts` uses, so it survives a restore and identifies the instance
independently of any database row.

Unknown fields survive a round trip: a backup written by a newer version isn't
silently stripped by an older one.

The normative definition, with tests, is
[`shared/backup.ts`](../shared/backup.ts). `scripts/verify-backup.sh`
implements the same rules in bash, because the machine you're restoring onto may
not have a working application on it yet — which is usually the reason you're
restoring.

## Backups taken before v0.4

They have no manifest. `verify` says so, checks that a database is present, and
lets the restore proceed as unverifiable. They still work; nothing about them
can be checked.

## Automating it

```bash
# 3am daily, keep 14 days
0 3 * * * cd /opt/sovrgnnet && ./sovrgnnet backup >/dev/null 2>&1
0 4 * * * find /opt/sovrgnnet/backups -name '*.tar.gz' -mtime +14 -delete
```

A backup on the same machine doesn't help when that machine is what fails. Copy
them somewhere else, and restore one occasionally — an untested backup is a
hypothesis, not a backup.
