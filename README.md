# SOVRGNnet

**Sovereign communications.** A self-hosted, Discord-style platform built on open protocols — Matrix for messaging, IPFS for file storage, and optional Web3 identity — designed to run on your own hardware under your own domain.

Production target: **[sovrgnnet.cc](https://sovrgnnet.cc)** · Operated by [Formicaria](https://formicaria.us)

> **Status: v0.1.0 alpha.** Text chat, file sharing, and invites work end-to-end on a real Matrix homeserver. Voice and E2EE are on the [roadmap](docs/ROADMAP.md). See [CHANGELOG.md](CHANGELOG.md) for what shipped.

## Run it

```bash
git clone https://github.com/Formicaria/SOVRGNnet.cc.git sovrgnnet
cd sovrgnnet
./install.sh
```

The installer asks how people should reach your instance, generates every
password and secret, and starts the stack. **No domain and no accounts are
required** — one of the options gets you a public `https://` link with no
signup anywhere. The app migrates its own database on boot, so there's no
separate setup step to forget.

Never done this before? [**QUICKSTART.md**](QUICKSTART.md) walks through it
assuming no prior experience.

**No Docker?** [`scripts/install-lxc.sh`](docs/LXC.md) installs everything as
plain systemd services — PostgreSQL, Conduit, Kubo, and the app. Built for a
Proxmox LXC, fine on any bare Debian box.

Day to day, either install: `sovrgnnet status | start | stop | url | backup | update`

## What it is

SOVRGNnet gives a community the familiar Discord experience — servers, channels, text chat, voice, file sharing — without renting it from a corporation:

- **Messaging** rides on [Matrix](https://matrix.org) (Conduit homeserver), an open, federated, end-to-end-encryptable protocol.
- **Files** are stored on [IPFS](https://ipfs.tech) with WebTorrent for large transfers.
- **Identity** starts with plain email/password; wallet-based login (ENS, WalletConnect) is on the roadmap as an optional layer, not a requirement.
- **Everything self-hosts** via Docker Compose: app, Postgres, Matrix, IPFS, and nginx in one stack.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, Tailwind 4, shadcn/ui, wouter |
| API | Express + tRPC 11, Zod |
| Database | PostgreSQL + Drizzle ORM |
| Messaging | Matrix (Conduit homeserver), matrix-js-sdk |
| Storage | IPFS (Kubo), WebTorrent |
| Web3 (optional) | wagmi, viem, RainbowKit, ethers |
| Deploy | Docker Compose, nginx, ARM64-friendly (Pi 5 supported) |

## Repository layout

```
client/          React frontend (pages, contexts, shadcn/ui components)
server/          Express + tRPC backend
  _core/         Server plumbing: env, context, auth, vite integration
  routers.ts     API surface (servers, channels, messages, files, matrix proxy)
  db.ts          Drizzle query helpers
shared/          Types and constants shared by client and server
drizzle/         Schema, migrations, snapshots
scripts/         Setup, backup, and restore scripts
docs/            Architecture, audit, roadmap, deployment
```

## Quick start (development)

Requirements: Node 22+, pnpm 10, and a Postgres instance (or run `docker compose up db`).

```bash
pnpm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET at minimum
pnpm dev                    # migrates on boot, then serves on :3000
```

`pnpm db:push` regenerates migration SQL after a schema change; you don't need
it to run the app. The server applies pending migrations itself at startup.

Useful commands: `pnpm check` (typecheck), `pnpm test` (vitest), `pnpm build` (production build), `pnpm format`.

## Deployment

`./install.sh` covers every hosting shape below; these are the underlying
compose profiles if you'd rather drive it yourself.

| Profile | Command | Reachable at |
|---|---|---|
| *(none)* | `docker compose up -d` | `http://<lan-ip>:3000` |
| `quick` | `docker compose --profile quick up -d` | random `*.trycloudflare.com`, no account |
| `tunnel` | `docker compose --profile tunnel up -d` | your domain, via a Cloudflare tunnel token |
| `proxy` | `docker compose --profile proxy up -d` | your domain, your own TLS certs in `./ssl` |

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the sovrgnnet.cc production
guide, including DNS, TLS, and the Matrix well-known configuration.

Two settings are worth knowing about:

- `MATRIX_SERVER_NAME` is baked into every Matrix user and room ID at creation
  time. Changing it after first launch orphans existing chat history.
- `MATRIX_ALLOW_FEDERATION` defaults to `false`. Your homeserver talks to
  nobody until you turn it on.

## Documentation

- [QUICKSTART.md](QUICKSTART.md) — setup for someone who's never done this before
- [docs/LXC.md](docs/LXC.md) — native install, no Docker (Proxmox LXC or bare Debian)
- [docs/AUDIT.md](docs/AUDIT.md) — current state of the codebase: what works, what's broken, what's missing
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased plan from here to a live platform
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — hosting on sovrgnnet.cc

## License

MIT
