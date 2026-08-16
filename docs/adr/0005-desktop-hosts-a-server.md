# ADR 0005 — The desktop app installs a server, with everything bundled

**Status:** Accepted · August 2026 · **not yet built** (targeted at v0.3.0)
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
3. Bundle Conduit and Kubo
4. First-run flow: host or connect, with hosting genuinely optional
5. Backups surfaced somewhere a person will find them
6. Auto-update, which this decision makes load-bearing

Steps 1 and 2 are the hard ones. Everything after is assembly.
