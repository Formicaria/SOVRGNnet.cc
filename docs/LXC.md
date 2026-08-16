# Running SOVRGNnet in an LXC container (no Docker)

Everything runs as ordinary systemd services — PostgreSQL, Dendrite, Kubo, and
the app itself. No Docker, no nesting, no container-in-a-container. On Proxmox
this is the lighter option: an LXC uses the host kernel directly, so you're
not paying for a VM's memory reservation or a Docker layer on top of that.

Idle footprint is roughly 700 MB of RAM and about 3 GB of disk before any
messages exist.

**Prefer Docker?** Use [`install.sh`](../QUICKSTART.md) instead. Both installs
are supported and `sovrgnnet` drives either one.

---

## 1. Create the container

On the **Proxmox host**, with a Debian 13 template downloaded:

```bash
pct create 200 local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst \
  --hostname sovrgnnet \
  --cores 2 --memory 4096 --swap 1024 \
  --rootfs local-lvm:16 \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --features nesting=1 \
  --unprivileged 1 \
  --onboot 1 \
  --start 1
```

Adjust the template name to whatever `pveam available` offers you, and the
storage names to match your setup.

Notes on those flags:

- **`--unprivileged 1`** — the container's root is not the host's root. Keep it.
- **`--features nesting=1`** — not for Docker here; some systemd units and
  `systemd-detect-virt` want it, and it costs nothing.
- **`--memory 4096`** — Dendrite and the Node build both want room. Dendrite is
  heavier than Conduit was; its own docs suggest 8 GB for a comfortable
  *federated* deployment, though a private instance for a handful of people is
  content with far less. 2 GB works if you build elsewhere; 1 GB does not.
- **`--rootfs 16`** — the build needs a few GB transiently. IPFS grows with
  whatever people share; size for that, not for today.

You can do all of this in the Proxmox web UI instead. The only setting that
isn't the default is memory.

## 2. Install

Enter the container (`pct enter 200`, or the console in the web UI) and:

```bash
apt update && apt install -y git
git clone https://github.com/Formicaria/SOVRGNnet.cc.git /opt/sovrgnnet
/opt/sovrgnnet/scripts/install-lxc.sh
```

It asks the one question — how people should reach you — then installs
PostgreSQL, Dendrite, Kubo, Node, and the app; generates every secret; wires up
systemd; starts everything; and prints the URL.

Ten to fifteen minutes on modest hardware, most of it compiling the frontend.

## 3. Use it

`sovrgnnet` is on the PATH, and works exactly as it does on the Docker install:

```bash
sovrgnnet status      # every service, at a glance
sovrgnnet url         # what address people use
sovrgnnet logs        # follow the app (add a unit name for others)
sovrgnnet backup      # one archive with everything
sovrgnnet update      # pull, rebuild, restart
```

---

## What ends up where

| Thing | Location |
|---|---|
| App source and build | `/opt/sovrgnnet` |
| Settings and secrets | `/etc/sovrgnnet/sovrgnnet.env` (0640) |
| Matrix config | `/etc/dendrite/dendrite.yaml` |
| Matrix data | in PostgreSQL (the `dendrite` database) |
| Matrix identity | `/etc/dendrite/matrix_key.pem` |
| IPFS data | `/var/lib/ipfs` |
| PostgreSQL | the distribution default |
| Backups | `/opt/sovrgnnet/backups` |

Services: `sovrgnnet`, `dendrite`, `ipfs`, `postgresql`, and
`sovrgnnet-tunnel` if you chose a public address.

Each runs as its own unprivileged system user under systemd hardening —
`ProtectSystem=strict`, `ProtectHome`, `NoNewPrivileges`, and a single
writable path each.

## What listens where

| Port | Bound to | What |
|---|---|---|
| 3000 | all interfaces | the app |
| 6167 | 127.0.0.1 | Dendrite |
| 5001 | 127.0.0.1 | IPFS API |
| 8081 | 127.0.0.1 | IPFS gateway |
| 5432 | 127.0.0.1 | PostgreSQL |
| 4001 | all interfaces | IPFS swarm (peering) |

Only 3000 and 4001 are reachable from outside the container. The IPFS API on
5001 is an unauthenticated admin socket — anyone who reaches it controls the
node — which is why it stays on loopback.

## Backups

`sovrgnnet backup` produces one archive containing a `pg_dump` of both
databases, the homeserver's signing key, the IPFS blockstore, and your
settings file. Nightly:

```bash
crontab -e
0 3 * * * /usr/local/bin/sovrgnnet backup >/dev/null 2>&1
```

Copy those archives off the container — Proxmox Backup Server, another node,
anywhere else. They contain your secrets; treat them accordingly.

Restore onto a fresh container: install as above, then
`/opt/sovrgnnet/scripts/restore.sh`.

## Two settings that matter

**`MATRIX_SERVER_NAME`** is written into every Matrix user and room ID the
moment they're created. Changing it later orphans all existing history. The
installer picks `sovrgn.local` for a private instance, or `matrix.<domain>` if
you gave it a domain. Decide before your first login, not after.

**`MATRIX_ALLOW_FEDERATION`** defaults to `false`. Your homeserver talks to
nobody until you change it in `/etc/sovrgnnet/sovrgnnet.env`, set
`disable_federation: false` in `/etc/dendrite/dendrite.yaml`, and restart
both services. Federation also needs `MATRIX_SERVER_NAME` to be publicly
resolvable and reachable.

## When something's wrong

```bash
sovrgnnet status                    # which service is unhappy?
journalctl -u sovrgnnet -n 50       # the app
journalctl -u dendrite -n 50        # the homeserver
journalctl -u ipfs -n 50            # file storage
```

**The app restarts in a loop.** Almost always the database. Check
`journalctl -u sovrgnnet` for a connection error, then
`systemctl status postgresql`. The app applies its own migrations on boot and
exits deliberately if it can't reach Postgres — that's the loop you're seeing.

**The homeserver won't start.** Check `server_name` in
`/etc/dendrite/dendrite.yaml` — it must be a valid hostname. Changing it after
data exists orphans that data; it can't be salvaged by editing config. Also
check that the `dendrite` database exists and `matrix_key.pem` is readable by
the `dendrite` user.

**IPFS complains about a repo lock** after an unclean shutdown:
`rm /var/lib/ipfs/repo.lock` and restart.

**Out of memory during the build.** `pnpm build` is the peak. Give the
container 4 GB, or add swap.

## Keeping it current

`sovrgnnet update` covers the app. The rest are yours:

```bash
apt update && apt upgrade        # Node, PostgreSQL, system packages
```

Dendrite and Kubo don't come from apt. Kubo is a downloaded binary; Dendrite is
**built from source during install**, because upstream publishes no binaries at
all — only source tarballs. That's also why the install takes a few minutes
longer than it otherwise would.

Dendrite's release cadence is slow — the version pinned here was published in
August 2025 — so this is worth watching rather than assuming:
[Dendrite releases](https://github.com/element-hq/dendrite/releases). To move
to a newer one:

```bash
systemctl stop dendrite
DENDRITE_VERSION=v0.15.3 /opt/sovrgnnet/scripts/install-lxc.sh
```

Re-running the installer is safe: it keeps your secrets, your signing key, and
your data, and only rebuilds what changed.

**Before any upgrade, take a backup.** `sovrgnnet backup` takes seconds, and a
homeserver upgrade touches the database that holds every conversation.
