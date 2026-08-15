# SOVRGNnet

**Sovereign communications.** A self-hosted, Discord-style platform built on open protocols — Matrix for messaging, IPFS for file storage, and optional Web3 identity — designed to run on your own hardware under your own domain.

Production target: **[sovrgnnet.cc](https://sovrgnnet.cc)** · Operated by [Formicaria](https://formicaria.us)

> **Status: v0.1.0 alpha.** Text chat works end-to-end: accounts, servers, channels, and messages riding on a real Matrix homeserver. Voice, file sharing, and E2EE are on the [roadmap](docs/ROADMAP.md). See [CHANGELOG.md](CHANGELOG.md) for what shipped.

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
pnpm db:push                # generate + run migrations
pnpm dev                    # starts server + Vite on :3000
```

Useful commands: `pnpm check` (typecheck), `pnpm test` (vitest), `pnpm build` (production build), `pnpm format`.

## Deployment

The full stack deploys with Docker Compose behind nginx. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the sovrgnnet.cc production guide, including DNS, TLS, and the Matrix well-known configuration.

```bash
cp docker.env.template .env
# edit .env — set real passwords and secrets
docker compose up -d
```

## Documentation

- [docs/AUDIT.md](docs/AUDIT.md) — current state of the codebase: what works, what's broken, what's missing
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased plan from here to a live platform
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — hosting on sovrgnnet.cc

## License

MIT
