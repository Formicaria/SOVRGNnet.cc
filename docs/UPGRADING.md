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
2. **Docker installs:** `docker compose up -d --build`, with every base image
   pinned to a version tag in the compose file. **Native (LXC) installs:**
   `pnpm install --frozen-lockfile && pnpm build`, then a service restart.
3. On boot the instance applies any pending database migrations itself,
   in order, exactly once (they're journaled). There is no separate migrate
   step to remember and no harm in restarting mid-way — an applied migration
   is never re-applied.

## When the boring path won't do

```bash
sovrgnnet update --force
```

Two situations call for it, and they are different problems with one fix:

- **The repository won't fast-forward.** Someone edited a file on the box, or
  a branch diverged. The ordinary `update` stops rather than merging silently.
  `--force` resets to `origin/<branch>`, discarding local commits and edits.
- **The images are stale even though the version is current.** A plain
  `up -d --build` reuses whatever is in the local image cache, so a version tag
  that was *rebuilt* upstream never arrives. `--force` runs `pull`, then
  `build --pull --no-cache`, then `up --force-recreate`.

The second one is the sneaky one. Nothing looks wrong: every machine reports
the same version, `docker compose ps` is green, and one of them is running
months-old base layers because it happened to pull first.

It takes a backup before it touches anything and aborts if that backup fails —
the confirmation prompt is only honest if there is something to go back to.

**It does not run `git clean`.** That is the obvious way to make a tree match
the remote exactly, and it would delete `.env`: the database password, the JWT
secret, the Matrix shared secret. Losing `MATRIX_SERVER_NAME` is unrecoverable
in the strict sense — it is baked into every user ID that exists, and `restore`
refuses a server-name mismatch. So untracked files are left alone, `--force` or
not, and a test enforces it.

Add `--yes` to skip the prompt when scripting. Nothing else about it changes.

## What "deterministic" means here

The same three inputs produce the same instance everywhere:

- **Images are pinned to a version tag**, never `latest`. Two operators
  running the same version of this repository run the same *versions* of
  Postgres, Dendrite, Kubo and nginx.

  Not the same bytes, and this page said "the same bytes" for a while. It
  was wrong. A tag is a mutable pointer: `postgres:16.6-alpine` is rebuilt
  whenever Alpine ships a base-layer security fix, and the same tag then
  resolves to a different image. Usually that is the fix you wanted. It is
  still not reproducibility, and the difference matters in exactly one
  situation — the one where you are trying to work out why two machines
  claiming the same version behave differently.

  `Dockerfile` is looser still: `node:22-alpine` floats across every 22.x
  patch. Whatever `docker compose up --build` pulls that day is what runs.

  Digest pinning is the fix and it is not free: `@sha256:…` means base-layer
  CVEs stop arriving on their own, so something has to bump the digests on
  purpose. See "Keeping it current" below, which is that something.
- **The lockfile is the dependency tree.** `--frozen-lockfile` fails rather
  than resolving something new at install time.
- **Migrations are linear and journaled.** Skipping releases is safe: an
  instance three versions behind applies three versions of migrations in
  order on its next boot. There are no "you must pass through vX.Y" steps,
  and if one ever becomes necessary it will be a loud failure with
  instructions, not a corrupted upgrade.

## Keeping it current

An instance is a production service with a public ingress, so "update it when
you remember" is not a policy. But nothing here auto-updates by default, and
that is a decision rather than an omission.

### What updates on its own

**The host's OS packages, security only.** On the Proxmox container or VM:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

This is the layer with the most drive-by exposure and the least ability to
break anything stateful. Turn it on.

### What must not update on its own

**The images.** Specifically these two, for concrete reasons:

- **Postgres.** A major version bump is a one-way data-directory migration.
  Pinned to `16.6-alpine`, an accidental 17 refuses to start — loud, and your
  data is fine. On a `latest` tag it happens at whatever hour the puller runs,
  and the recovery is a restore.
- **Dendrite.** It migrates its own schema on boot, forward only. An automatic
  pull is an unattended one-way migration of your entire message history with
  nobody watching and no backup taken first.

This is why **Watchtower is the wrong tool for this stack**, and it is worth
naming because it is what everyone reaches for. It pulls and restarts on its
own schedule. Against a stateless web app that is fine. Against two databases
and a homeserver it is an unsupervised migration with no backup step and no
way back.

### What updates on a schedule, with a human in it

Automate the *decision*, not the runtime:

1. Renovate opens a pull request that bumps a pin. `renovate.json` groups the
   things that only work when moved together — Express with the transitive
   advisories that arrive with it, matrix-js-sdk with its Rust bindings,
   Tauri's two package managers — and labels the two that migrate data
   one-way, Postgres majors and Dendrite, `needs-migration-plan`.
2. CI runs the full `./scripts/e2e.sh` against it: a real sign-up, a real
   message, real Olm/Megolm, and a backup that has to survive a schema drop.
   That job is gated on the `dependencies` label precisely so this case gets
   it, without every other pull request paying for it.
3. A person merges it. **Nothing auto-merges**, and a test enforces that — a
   bot that merges its own pull requests is Watchtower with extra steps, and
   the argument above is that nothing in this stack should update itself.
4. `sovrgnnet backup && sovrgnnet update` on the box.

Step 2 is what makes this sustainable, because the reason version bumps rot is
that testing them is manual.

This page previously described step 2 as though it already happened. It didn't
— CI ran unit tests against a real Postgres and never brought the stack up, so
an image bump could have gone green without anything exercising a migration.

### The one to watch

`cloudflared` is the only process here with an unsolicited path to the
internet, and it is the thing standing between the public and everything else.
It is currently pinned to `2024.12.2`. Of everything in the compose file, this
is the pin whose age matters most, and it should be first in any bump.

`ghcr.io/element-hq/dendrite-monolith` deserves a second look for a different
reason: the Element fork is in maintenance mode and takes security fixes only.
That is survivable — arguably it is what you want from a homeserver — but it
means "no new releases" is not the same signal here as it is elsewhere, and a
long-term plan should be an explicit decision rather than a default.

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
