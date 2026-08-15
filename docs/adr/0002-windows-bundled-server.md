# ADR 0002 — The Windows app installs a server, and it runs on WSL2

**Status:** Accepted · August 2026
**Builds on:** [ADR 0001](0001-multi-server-client.md)

## Context

The desktop app should do more than connect to servers other people run. On
Windows it should *be* one: install it, and you're hosting — the way Minecraft
lets you open a world to LAN without renting anything. Settings are configured
from the client, not by editing files over SSH.

That's the right ambition. It runs into a specific wall.

**Conduit ships Linux binaries only.** From its own deployment documentation:
"we do recommend running it on a Linux server. We therefore only offer Linux
binaries." Our entire server stack assumes Linux — Conduit, PostgreSQL as we
configure it, the systemd units, `install-lxc.sh`.

So "install a server on Windows" needs an answer to: what runs the homeserver?

## Options

**Native Windows binaries, swapping Conduit for Dendrite.** Dendrite is Go and
cross-compiles cleanly, Kubo publishes Windows builds, PostgreSQL has portable
archives. No virtualisation, a genuinely native install.

The cost is a **second homeserver implementation, permanently**. Two config
formats, two sets of behavioural quirks, two upgrade cadences, two things to
test every release — and any Matrix bug report starts with "which homeserver?"
For a project this size that tax compounds forever, and it buys us a platform
that is not where the servers actually live.

**Docker Desktop.** Reuses `docker-compose.yml` exactly. But it needs WSL2
underneath *anyway*, adds a second large install, and Docker Desktop's licence
is not free for larger businesses — a bad thing to require of software about
not depending on companies.

**WSL2.** Windows runs a real Linux kernel. The same Conduit binary, the same
PostgreSQL, the same `install-lxc.sh` that already works. One server
implementation everywhere.

## Decision

**WSL2.**

The Windows app provisions a dedicated WSL2 distribution, installs the standard
Linux stack into it, and supervises it from the client. What runs on a Windows
gaming PC is byte-for-byte what runs on Zach's LXC.

Server administration is a **normal authenticated API**, not a local
back-channel: `admin.getSettings`, `admin.updateSettings`, `admin.listUsers`,
`admin.setUserRole`, gated on the instance admin role. Administering a box in
your closet from the laptop in your hand is the ordinary case, not a special
one — a local server is just a server whose address happens to be `localhost`.

Settings move from environment variables into an `instanceSettings` table, with
the environment as bootstrap defaults for a fresh install. Once an admin saves
anything, the database wins.

## Consequences

**WSL2 is a hard requirement on Windows.** It needs virtualisation enabled in
firmware, Windows 10 2004+, and about a gigabyte of overhead. It's blocked
outright on some corporate machines. `wsl --install` is one command on a
current Windows 11, but it wants a reboot, and the installer has to handle that
gracefully rather than appearing to hang.

**First launch is slow and large.** Downloading a distro image plus the stack
is a multi-minute, multi-gigabyte affair. The UI has to be honest about that
instead of showing a spinner.

**Networking needs care.** WSL2 sits behind a NAT with an address that changes
across reboots. Reaching the server from other machines on the LAN means
port proxying (`netsh interface portproxy`) maintained across restarts, or the
tunnel — which sidesteps the problem entirely and is likely the better default
for "my friends should be able to join."

**Backups live inside the distro.** `sovrgnnet backup` writes into WSL's
filesystem, which people don't think of as a real disk and which
`wsl --unregister` erases without ceremony. The Windows app must surface
backups somewhere visible in Windows.

**No native Windows server, ever, under this decision.** If WSL2 is
unavailable, the app is a client only. That's an honest limitation to state up
front rather than a gap to discover after installing.

### What it buys

One server implementation. Every fix, every hardening pass, every line of
`install-lxc.sh` applies identically on a Raspberry Pi, a Proxmox LXC, a VPS,
and a Windows desktop. Given a small team, one well-tested path beats two
half-tested ones — and the alternative was maintaining a second Matrix
homeserver forever to serve the platform least likely to be hosting anything.

## Also decided here

**The first account registered becomes the instance admin.** This was already
promised by the installer and QUICKSTART, and was simply not implemented —
`adminProcedure` existed and checked `role === 'admin'`, but `createLocalUser`
never assigned it, so no account on any instance was ever an administrator.
Now the first registration takes the role, and an admin cannot demote
themselves, since an instance with no administrator can only be repaired from a
database console — exactly what this surface exists to avoid.
