# Changelog

## Unreleased

### Anyone can run this now

- **`./install.sh`** — one command from clone to running instance. Asks how
  people should reach you, generates every secret, builds, starts, and prints
  the URL. No domain, no Cloudflare account, no Docker knowledge required.
- **A public link with no signup anywhere.** The `quick` profile runs a
  Cloudflare Quick Tunnel: a real `https://` address in about a minute, no
  account and no port forwarding. Random and non-permanent by nature — the
  tradeoff for needing nothing at all.
- **`./sovrgnnet`** — `start`, `stop`, `restart`, `status`, `url`, `logs`,
  `backup`, `update`. The whole operational surface in plain words.
- **The app migrates itself.** On boot it waits for Postgres and applies
  pending migrations via drizzle-orm's runtime migrator. There is no longer a
  migration step to forget — and the old instructions could not have worked,
  since `drizzle-kit` is a dev dependency absent from the production image.
- **`scripts/install-lxc.sh`** — a second install with no Docker at all.
  PostgreSQL, Conduit, Kubo, and the app as plain systemd services, each under
  its own unprivileged user with `ProtectSystem=strict` and a single writable
  path. Built for a Proxmox LXC; works on any bare Debian or Ubuntu machine.
  Kubo's download is checksum-verified. See [docs/LXC.md](docs/LXC.md).
- **`sovrgnnet` drives either install.** It detects Docker vs. native and
  translates to `docker compose` or `systemctl`; `backup.sh` does the same.
  One set of commands regardless of how you installed.
- **[QUICKSTART.md](QUICKSTART.md)** — setup written for someone who has never
  done this before, including what to do when it goes wrong.

### Community features

- **Roles are enforced.** owner > admin > moderator > member, checked in one
  place and applied across the API. Admins manage channels and invites;
  moderators delete messages and remove people. Nobody can grant a role at or
  above their own, or moderate someone ranked equal or higher.
- **Member list** with roles, live online dots, and a moderation menu.
- **Kick and ban**, mirrored onto Matrix room membership. Bans are recorded
  app-side too, so a banned user can't stroll back in via discovery or an
  invite link.
- **Message editing** — sent as a proper Matrix `m.replace` so third-party
  clients render it correctly. Only ever your own messages; moderators can
  delete but never rewrite what someone said.
- **Reactions** — six quick emoji, toggled per user, stored on the message and
  echoed to Matrix as `m.annotation`.
- **Typing indicators and presence**, pushed to Matrix so Element sees them
  and tracked in-process for our own UI.
- Matrix power levels are kept in sync with app roles as a best-effort mirror;
  SOVRGNnet's own checks remain authoritative.

### Hardening

- **IPFS's admin API is no longer exposed.** Port 5001 was published to the
  host — anyone who could reach it controlled the node. It and the gateway
  are loopback-only now, as is Conduit's 8008.
- **Homeserver registration is gated** behind a generated token instead of
  standing open to the internet.
- **Federation defaults to off.** Your instance talks to nobody until you set
  `MATRIX_ALLOW_FEDERATION=true`.
- `MATRIX_SERVER_NAME` now actually reaches the app container. Without it,
  Matrix space links were being built with `localhost`.
- Log rotation on every service; nginx moved behind a `proxy` profile since
  the tunnel makes it redundant.
- `backup.sh` and `restore.sh` rewritten for Postgres — they were still
  calling `mysqldump` against a database that hasn't been MySQL for months.
  Restore is now interactive and picks up where a backup left off.

### Files

- File sharing over IPFS: uploads pin to the instance's own Kubo node;
  authenticated, membership-enforced upload/download routes; images inline
  and file cards in a unified channel timeline; paperclip + drag-and-drop.

### Tests

- 55 passing, up from 23: permission ranking and moderation authority,
  typing/presence lifecycle including expiry.

## v0.1.0 — 2026-08-15 (alpha)

First working release: a self-hosted, Discord-style platform with real
text messaging over Matrix.

### Platform
- First-party email/password auth: scrypt password hashing, httpOnly JWT
  session cookies, login rate limiting. No third-party auth dependency.
- Matrix bridge: one homeserver account provisioned per user, tokens held
  server-side; servers are Spaces, channels are rooms, every message is a
  Matrix event on your own Conduit instance.
- Three-pane chat UI: server rail, channel list, live message pane with
  create/join/discover flows.
- Membership enforcement on every read and write; owner-only channel
  creation; public server discovery and join.
- PostgreSQL via Drizzle with a clean migration history.

### Infrastructure
- Single Docker Compose stack: app, Postgres 16, Conduit, IPFS (Kubo),
  nginx, optional cloudflared tunnel.
- Deployment architecture for sovrgnnet.cc: Cloudflare Pages landing site
  (with Matrix well-known delegation) + Cloudflare Tunnel to the homelab.
- GitHub Actions CI (typecheck, migrate, test against Postgres, build) and
  release image publishing to GHCR on tag.
- Static landing site in `site/`, zero-build, Pages-ready.

### Removed
- Manus scaffold residue, Supabase auth, MySQL compose configs, dead
  dependencies (js-ipfs, webtorrent, aws-sdk), network-dependent tests.

### Known limitations (route to roadmap)
- No E2EE yet — messages are plaintext on your own homeserver (Phase 6).
- Message updates poll every 3s; a push sync bridge is planned.
- No file sharing UI yet (Phase 3), no voice (Phase 6), no password reset.
