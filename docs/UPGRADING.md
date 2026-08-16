# Upgrading an instance

The upgrade process is deliberately boring: one command, deterministic inputs,
and a way back that was taken *before* anything changed. This page is the
whole of it, including the parts that go wrong.

## The short version

```bash
sovrgnnet backup     # first. not optional. this is the way back.
sovrgnnet update
sovrgnnet status
```

`update` does exactly this, in order:

1. `git pull --ff-only` — fast-forward only. A repository with local edits
   stops here rather than being silently merged; the error tells you to look
   at `git status`.
2. **Docker installs:** `docker compose up -d --build` with every base image
   pinned by digest in the compose file. **Native (LXC) installs:**
   `pnpm install --frozen-lockfile && pnpm build`, then a service restart.
3. On boot the instance applies any pending database migrations itself,
   in order, exactly once (they're journaled). There is no separate migrate
   step to remember and no harm in restarting mid-way — an applied migration
   is never re-applied.

## What "deterministic" means here

The same three inputs produce the same instance everywhere:

- **Images are pinned**, never `latest`. Two operators running the same
  version run the same bytes.
- **The lockfile is the dependency tree.** `--frozen-lockfile` fails rather
  than resolving something new at install time.
- **Migrations are linear and journaled.** Skipping releases is safe: an
  instance three versions behind applies three versions of migrations in
  order on its next boot. There are no "you must pass through vX.Y" steps,
  and if one ever becomes necessary it will be a loud failure with
  instructions, not a corrupted upgrade.

## Downgrading

Not supported, on purpose. Migrations move the schema forward; running old
code against a newer schema is undefined in the way that quietly eats data.
The way back is the backup taken in step one:

```bash
sovrgnnet restore
```

Restore validates before it touches anything — format version, schema
compatibility, server-name match — and refuses rather than detaching history.

## Version-specific notes

### → 0.5.0

- **Encrypted backups.** Set `SOVRGN_BACKUP_PASSPHRASE` before `sovrgnnet
  backup` and the archive is sealed with scrypt + AES-256-GCM; restore
  prompts for the passphrase. Nothing changes if the variable is unset. A
  lost passphrase means a lost backup — store it separately from the file.
- **Metrics.** `GET /metrics` (Prometheus text format) now exists. It is
  unauthenticated unless `METRICS_TOKEN` is set; stock deployments don't
  route it publicly. Point Prometheus at it and alert on
  `sovrgnnet_database_up == 0`.
- **Appservice ingest (optional, recommended).** To let clients author
  events over their own Matrix sessions, generate two tokens
  (`openssl rand -hex 32`), fill `dendrite/appservice.yaml.template`, list
  the file under `app_service_api.config_files` in `dendrite.yaml`, set
  `MATRIX_APPSERVICE_AS_TOKEN` / `MATRIX_APPSERVICE_HS_TOKEN` in the
  instance environment, and restart both services. The `eventIngest`
  capability turns true by itself; leaving all of it unset changes nothing.

### Instances created before 0.4.1 — room join rules (T18)

Communities created before 0.4.1 have Matrix rooms with `public` join rules
(see THREAT_MODEL T18). New communities are created correctly; existing
rooms keep their creation-time state. Until repair tooling exists, the
options are honest if unglamorous: repair by hand (as the room creator, via
a Matrix client that can edit room settings, set the space to invite-only
and each channel's join rule to restricted-by-space), or recreate the
community and invite members to it. This matters only for instances whose
homeserver is reachable from outside.

## When an upgrade goes wrong

`sovrgnnet status` first — it distinguishes "app down" from "database down"
from "homeserver down". `sovrgnnet logs` second. The failure modes seen so
far, in order of frequency: local git edits blocking the fast-forward
(commit or stash them), a compose build failing on disk space, and a native
install missing a new system dependency called out in the release notes.
Nothing in the update path deletes data; the worst state it can reach is
"stopped", and `sovrgnnet restore` exists for everything beyond it.
