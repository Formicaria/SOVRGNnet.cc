# ADR 0005 — The desktop app installs a server, with everything bundled

**Status:** Accepted · August 2026 · implemented as of 0.6 (see the revision
note at the end — the earlier "implemented in v0.3.0" claim was wrong)
**Supersedes:** the WSL2 approach in [ADR 0002](0002-windows-bundled-server.md), for the desktop case only

## Context

Installing SOVRGNnet on Windows or Linux should mean you're hosting. Not "you
can now connect to a server someone else runs" — you double-click an installer,
and afterwards there is a server on your machine, usable at first launch,
without a terminal.

ADR 0002 answered the Windows half with WSL2: run the same Linux stack inside
a Linux kernel Windows already ships. That reasoning was sound and remains
sound for its purpose — one server implementation, every fix applying
everywhere. It is also, for this purpose, wrong.

WSL2 needs virtualisation enabled in firmware, a reboot partway through
install, several gigabytes downloaded on first launch, and it is blocked
outright on managed machines. Someone installing a chat app to talk to four
friends will not survive that, and the entire point of this work is the person
who would not survive that.

`install-lxc.sh` remains correct for a Proxmox container or a VPS, where a
terminal was always part of the arrangement.

## Decision

**Ship PostgreSQL, Conduit, and Kubo inside the installer**, supervised by the
Tauri process. No downloads at setup, no package manager, no root prompt, no
reboot. The app starts them on launch and stops them on quit.

The desktop client keeps working purely as a client — hosting is a thing you
turn on, not a thing you're forced into. Someone who only wants to join a
friend's server should never learn that a database exists.

## Consequences

These are the costs, written down before building rather than discovered
during. Each is a commitment, not a caveat.

**Packaging, three times over.** Every component needs a build for Windows,
macOS, and Linux, and on Windows none of the three is a first-class citizen.
This is the bulk of the work and it does not get easier with familiarity.

**A much larger download.** Hundreds of megabytes against the current handful.
That's the price of "no download step at setup" and it should be stated on the
download page rather than discovered on a metered connection.

**Three more things to keep patched, on our cadence.** A bundled Conduit is
our responsibility to update, not the distribution's. Conduit-family servers
shipped coordinated security fixes in early 2026; under this decision, getting
those to users means shipping a release promptly and users installing it.
Auto-update stops being a nicety.

**Postgres without a package manager is the schedule risk.** Embedding it means
owning data directory initialisation, and — the genuinely hard part — the
upgrade path when a user's bundled Postgres is older than the one a new release
expects. Postgres major upgrades require `pg_upgrade` or a dump/restore cycle,
on a machine we can't inspect, for a user who will not read an error message.
Getting this wrong destroys people's message history. **A backup taken before
any upgrade attempt, verified restorable, is not optional.**

**Port conflicts on a real desktop.** Unlike a dedicated LXC, this machine runs
other things. Fixed ports will collide. The supervisor has to allocate
dynamically and tell the app what it chose.

**Sleep, hibernation, and moving networks.** A laptop closes its lid. A server
process discovers its database vanished and its address changed. None of this
happens on a machine in a closet, and all of it happens on the machine this
decision targets.

**Uninstall has to mean something.** Removing the app must not silently delete
someone's messages, and must not silently leave gigabytes behind either. It
needs to ask, and the question needs to be comprehensible.

## What it buys

The thing this project keeps claiming and has not yet delivered: a person who
is not technical runs their own server, on their own machine, by
double-clicking an installer. Everything else — the sovereignty argument, the
open protocols, the absence of a landlord — is theoretical until that is true.

## Sequencing

1. Supervisor: start, stop, health-check, dynamic ports, structured logs
2. Bundle Postgres per platform, with initialisation and a tested upgrade path
3. Bundle the homeserver and Kubo
4. First-run flow: host or connect, with hosting genuinely optional
5. Backups surfaced somewhere a person will find them
6. Auto-update, which this decision makes load-bearing

Steps 1 and 2 are the hard ones. Everything after is assembly.

## Revision — what was actually built, and when

The status line above said "implemented in v0.3.0" for months during which
only `shared/hosting.ts` — the policy layer, tested and idle — existed.
Nothing supervised anything. This note corrects the record rather than
quietly editing it, because an ADR that claims more than the code is the
exact failure this repository keeps auditing itself for.

The implementation that landed differs from the 2026-08 text in five ways:

- **Dendrite, not Conduit.** [ADR 0006](0006-dendrite-replaces-conduit.md)
  replaced the homeserver after this was written; the bundle builds
  `dendrite` and its `generate-keys` from the same tag the Docker image pins.
- **A fourth binary: Node.** The app server runs on a bundled Node runtime
  with a self-contained `index.mjs` (everything bundled, ~2 MB), the client
  build, and the migration files beside it. The alternative — compiling the
  server to a native binary — would have made the desktop's server a
  different artifact from every other deployment's.
- **PostgreSQL comes from zonky's embedded-binaries distribution** — plain
  upstream Postgres repackaged per platform on Maven Central — pinned to the
  same major as the compose file.
- **The split is policy/process, exactly as `shared/hosting.ts` planned:**
  the Rust side (`desktop/src-tauri/src/hosting.rs`) unpacks, spawns, stops,
  and reports; which ports to offer, what states mean, and when the thing is
  usable are TypeScript, where they were already tested. Secrets are
  generated in the frontend and live in the OS keychain; Rust receives them
  per call and persists nothing but what a component's own config format
  requires.
- **v1 semantics are stated, not hidden:** the server runs while the app
  runs and stops when it quits; macOS installs are client-only until someone
  can debug its packaging on a real Mac; the hosted homeserver stays on
  loopback with the proxy path, so `clientMatrix` and `e2ee` are honestly
  false on a hosted-on-this-computer instance for now. Each of those is a
  future decision, not an accident.

The Postgres upgrade path — the schedule risk named above — remains the
rule in `needsBackupBeforeUpgrade`: a bundled major bump refuses to proceed
without a verified backup. That code is tested; the upgrade flow that calls
it ships with the first release that raises the bundled major.
