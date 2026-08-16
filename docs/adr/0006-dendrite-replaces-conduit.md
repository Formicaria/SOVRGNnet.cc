# ADR 0006 — Dendrite replaces Conduit

**Status:** Accepted · August 2026 · **not yet implemented**
**Forced by:** [ADR 0005](0005-desktop-hosts-a-server.md)

## Context

ADR 0005 commits to bundling a server into the desktop installer on Windows,
macOS, and Linux. Verifying what could actually be bundled turned up a
blocker: **Conduit ships Linux binaries only**, by their own documentation.

This is the same wall ADR 0002 hit, and WSL2 was how it got around it. ADR 0005
discarded WSL2 for good reasons — firmware virtualisation, a reboot mid-install,
a multi-gigabyte first launch — without noticing WSL2 was also carrying the
homeserver. Bundling on Windows therefore had nothing to bundle.

Four ways out were considered: build Conduit for Windows ourselves (Rust, but
RocksDB on Windows is exactly why upstream doesn't), Dendrite on Windows only
(two implementations forever), check whether the conduwuit fork ships Windows
builds, or move to Dendrite everywhere.

## Decision

**Dendrite, on every platform.** Conduit is removed.

Dendrite is Go, runs on Linux, macOS, and Windows Server, and — with the
PostgreSQL backend rather than SQLite — needs no cgo, so it cross-compiles
cleanly to every target we care about.

It brings a second benefit that wasn't the reason but might have been: Dendrite
speaks PostgreSQL, which we already run. Conduit kept its own RocksDB store, so
a hosted instance carried two storage engines, two backup paths, and two things
to corrupt. Now there is one database, backed up by one `pg_dump`.

Dendrite also embeds its own NATS, so this adds no new services.

## Consequences

**This is a migration, not a swap.** Conduit and Dendrite share the Matrix
protocol, not their storage. There is no in-place upgrade: an existing instance
means exporting or accepting the loss of local Matrix state. The app's own
Postgres data — accounts, servers, channels, message text — is untouched and
survives; what's lost is the homeserver's room state and event graph. On an
instance with real conversations that is a genuine loss and must be said out
loud rather than buried in a release note.

**Heavier at rest.** Conduit is famously frugal. Dendrite documents 1 GB as an
absolute minimum and 2–4 cores with 8 GB for a comfortable federated
deployment. For a Raspberry Pi or a modest LXC that is a real regression, and
for the desktop bundle it raises the floor on what machine can host.

**Configuration is different.** Dendrite uses a YAML config and requires a
generated signing key (`matrix_key.pem`) that Conduit never needed. Losing that
key changes the server's federation identity. It joins the signing key of the
identity provider on the short list of files that must be backed up separately
and never leave the machine.

**Registration gating needs re-verifying.** Conduit took a
`registration_token` and our `matrixService` registers accounts with
`m.login.registration_token`. Dendrite's equivalent must be confirmed before
this ships — an instance that silently accepts open registration because a
config key was renamed is exactly the class of bug that ADR-driven work is
meant to catch early. **Do not ship this migration until registration is
verified closed.**

**Upstream is stagnant, and we are taking that on.** An earlier draft of this
ADR claimed Dendrite benefits from active maintenance by Element. That was
wrong, and checking the release page is all it took to find out: the most
recent release is v0.15.2, published August 2025 — a year before this decision.
It also publishes **no binaries at all**, only source tarballs.

This was re-examined rather than glossed over, and Dendrite still wins, for one
reason: **no homeserver upstream ships Windows binaries.** Conduit doesn't.
conduwuit was archived in January 2026. Continuwuity — the active community
continuation, releasing every week or two — is Rust over RocksDB, which is
precisely why Conduit has no Windows build. Under ADR 0005 we compile the
homeserver ourselves on every platform regardless, so "does upstream publish
binaries" stops mattering and "can this be built for Windows at all" becomes
decisive. Dendrite is Go and cross-compiles cleanly with `CGO_ENABLED=0` on the
PostgreSQL backend.

The cost is real and should be stated: if a Matrix protocol security issue
lands, we may be waiting on a project that ships once a year, or patching it
ourselves. That is a genuine risk accepted with open eyes, not an oversight.
Continuwuity remains the fallback if Windows hosting is ever dropped or solved
another way.

## What has to change

- `docker-compose.yml` — the `matrix` service, its config, and its volume
- `scripts/install-lxc.sh` — binary download, config generation, systemd unit
- `server/matrixService.ts` — verify the registration flow; the rest of the
  Client-Server API usage is standard and should be unaffected
- `.env.example`, `docker.env.template`, `identity/` docs, `docs/LXC.md`,
  `docs/DEPLOYMENT.md`, and every reference to Conduit in the docs
- A migration note for anyone already running an instance, stating plainly
  that Matrix room state does not carry over

## Verify before implementing

1. Dendrite's registration-token support, and that registration is closed by
   default with our config
2. That a prebuilt Windows binary exists, or that `CGO_ENABLED=0` cross-builds
   cleanly for Windows with the Postgres backend
3. Resource use at rest on the smallest machine we claim to support, because
   the documented figures suggest the Raspberry Pi story may no longer hold
