```
   ███████╗ ██████╗ ██╗   ██╗██████╗  ██████╗ ███╗   ██╗
   ██╔════╝██╔═══██╗██║   ██║██╔══██╗██╔════╝ ████╗  ██║
   ███████╗██║   ██║██║   ██║██████╔╝██║  ███╗██╔██╗ ██║
   ╚════██║██║   ██║╚██╗ ██╔╝██╔══██╗██║   ██║██║╚██╗██║
   ███████║╚██████╔╝ ╚████╔╝ ██║  ██║╚██████╔╝██║ ╚████║
   ╚══════╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝

   Your own chat network. Your hardware. Your rules.
```

# SOVRGNnet

**Independent communications infrastructure you can operate yourself.**

SOVRGNnet is a network of independent instances. Each one is a complete
communications server — messaging, files, membership, moderation — run by
whoever owns the machine it's on. Communities talk through instances they
control rather than renting space inside somebody else's product.

Maintained by [Formicaria](https://formicaria.us) · reference instance at
[sovrgnnet.cc](https://sovrgnnet.cc)

> **Status: v0.5.1 alpha.** Messaging, files, invites, roles, and moderation
> work end-to-end. The desktop client connects to multiple independent
> instances. Backups are portable and verified before restore. **Channels are
> end-to-end encrypted by default** where the deployment can support it, with
> real limits — see [SECURITY.md](SECURITY.md). Full history in
> [CHANGELOG.md](CHANGELOG.md).

## What "sovereign" means here, technically

Not a slogan — a testable property:

> **If sovrgnnet.cc disappeared tomorrow, a correctly configured instance keeps
> running.** Its members keep talking, its backups keep restoring, its operator
> keeps control of the data.

Everything centralised is therefore optional and off by default:

| Service | Required? | If it vanishes |
|---|---|---|
| Instance (yours) | **Yes** — it *is* the product | Your instance is the thing |
| Matrix homeserver | Yes, bundled per instance | Runs on your hardware |
| PostgreSQL, IPFS | Yes, bundled per instance | Runs on your hardware |
| sovrgnnet.cc identity | **No** — off by default | Local accounts unaffected; existing sessions continue |
| Instance directory | **No** — not built, will be opt-in | Invite links keep working |
| Cloudflare | **No** — one of four access options | Use your own domain, TLS, or LAN only |

## Architecture

```
                         SOVRGNnet Network
              ┌─────────────────┼─────────────────┐
         Instance A        Instance B        Instance C
         SOVRGN API        SOVRGN API        SOVRGN API
         Matrix            Matrix            Matrix
         PostgreSQL        PostgreSQL        PostgreSQL
         IPFS              IPFS              IPFS
              └─────────────────┼─────────────────┘
                        SOVRGNnet Client
                    ┌───────────┼───────────┐
                Instance A  Instance B  Instance C
```

Responsibilities are deliberately split:

- **SOVRGN** owns instance identity, membership, roles, permissions,
  moderation, invites, and capability negotiation.
- **Matrix** owns message transport, rooms, events, sync, and (in future)
  message encryption.
- **IPFS** owns content addressing and media distribution.

The database is implementation state. The **SOVRGN protocol** — versioned
separately from the application — is the interoperability contract. See
[docs/PROTOCOL.md](docs/PROTOCOL.md).

Anyone can write another implementation, and there's a suite to check the claim:

```bash
pnpm conformance https://any-instance.example
```

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
plain systemd services — PostgreSQL, Dendrite, Kubo, and the app. Built for a
Proxmox LXC, fine on any bare Debian box.

Day to day, either install:

```
sovrgnnet status | start | stop | url | logs | update
sovrgnnet backup | verify | restore
```

Backups are portable: a manifest with a checksum per component, verified before
a restore touches anything, so moving to another machine is checkable rather
than hopeful. See [docs/BACKUP.md](docs/BACKUP.md).

## How identity works

Three modes, and only the first is required:

**Local accounts** — every instance issues its own. Email and password, scrypt
hashed, stored in that instance's database. No external service involved. This
always works and is the default.

**SOVRGNnet identity** *(optional, off by default)* — one account across every
instance that opts in, so a new computer picks up your servers. Sign-in goes
through Google, Microsoft, GitHub, or Discord, so no password store exists to
breach. Instances verify tokens against a **cached** public key, meaning the
identity service going down blocks new sign-ins but logs nobody out. Enable
with `INSTANCE_ALLOW_SSO=true`; leave it unset and your instance never contacts
it.

**Portable identity** *(future)* — the architecture keeps the identity service
non-authoritative so key-based identity can be added without it becoming so.

> SOVRGNnet can provide identity services. SOVRGNnet must not own your identity.

## How encryption works — and where it stops

Traffic to your instance is HTTPS. Between internal services it stays on
loopback. Files are streamed with membership checks rather than from a public
gateway.

**Channels are end-to-end encrypted by default**, with no switch to find. Every
channel created on an instance that can support it is Megolm-encrypted from the
moment it exists: keys live on members' devices, the homeserver and the
instance's own index hold ciphertext, and file contents are encrypted in the
browser before upload. The first time you sign in, the app offers you a
recovery key and backs your message keys up encrypted, so a new device can read
your history.

"Can support it" is about the deployment. It needs a homeserver clients can
reach and a wired appservice; without both there's nowhere for your keys to
live but the server, so the `e2ee` capability is false and channels are
plaintext. The default LXC install is like that.

Three things worth knowing before relying on it:

- **Metadata isn't encrypted anywhere.** Who's in a channel, who spoke, when,
  filenames, reactions. With contents encrypted, this is all an operator sees —
  and it's still a lot.
- **The operator can still mint a device on your account** — Matrix passwords
  here are derived from the app secret. That device gets the keys — refusing
  them breaks encrypted channels for everyone, so we don't. It appears in your
  device list as unverified, and noticing it is the entire defence.
- **The instance's own API can't write to an encrypted channel.** It holds no
  keys, so it refuses rather than sending plaintext. That's deliberate, and it
  means bots and integrations posting through the API won't work there.

[SECURITY.md](SECURITY.md) · [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) ·
[ADR 0011](docs/adr/0011-crypto-machine.md)

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19, Vite, Tailwind 4, shadcn/ui, wouter |
| API | Express + tRPC 11, Zod |
| Database | PostgreSQL + Drizzle ORM |
| Messaging | Matrix (Dendrite homeserver) |
| Storage | IPFS (Kubo) |
| Native client | Tauri 2 (Linux, macOS, Windows) |
| Identity *(optional)* | Ed25519 tokens, OAuth via Google/Microsoft/GitHub/Discord |
| Deploy | Docker Compose or plain systemd; ARM64-friendly |

Infrastructure images are pinned to explicit versions — an install is
deterministic, and upgrades are deliberate.

## Current limitations

Stated up front rather than discovered later:

- **Metadata is readable in every channel**, encrypted ones included. Channels
  on an instance that can't offer encryption are plaintext throughout.
- **The instance can log in as any of its users.** Derived Matrix passwords;
  the mitigation under encryption is device verification, which needs you.
- **Bots and integrations can't post through the API** on an instance with
  encryption, because the API holds no keys.
- **No session revocation.** Sessions are stateless and last a year.
- **No voice or video.**
- **No federation between instances** by default, and it's untested.
- **The instance directory doesn't exist** — you join via invite links.
- **No mobile apps.**
- **Live updates are polling** on instances that can't offer direct sync.
- **Presence is single-process** — correct for one instance, would need Redis
  to run several app processes.
- **No independent security audit.**

## Repository layout

```
client/          React frontend (pages, contexts, shadcn/ui components)
server/          Express + tRPC backend
  _core/         Server plumbing: env, context, auth, vite integration
  routers.ts     API surface (servers, channels, messages, files, matrix proxy)
  instance.ts    Instance identity, capabilities, join policy
  db.ts          Drizzle query helpers
shared/          Types shared by client and server
  protocol.ts    The SOVRGN protocol contract — versions, capabilities
desktop/         Tauri 2 native client
identity/        Optional identity provider (deploys separately)
drizzle/         Schema, migrations, snapshots
scripts/         Setup, backup, and restore scripts
docs/            Architecture, protocol, threat model, roadmap, deployment
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

Before pushing:

```bash
pnpm preflight            # ~20s — versions, typecheck, tests, build
pnpm preflight --full     # ~10m — plus real Postgres and a full-stack run
```

`pnpm e2e` stands up the whole stack, drives a real user journey through the
HTTP API, then takes a backup, **drops the schema**, restores, and checks the
data came back. See [docs/TESTING.md](docs/TESTING.md).

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

**Getting it running**

- [QUICKSTART.md](QUICKSTART.md) — setup for someone who's never done this before
- [docs/LXC.md](docs/LXC.md) — native install, no Docker (Proxmox LXC or bare Debian)
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — hosting on sovrgnnet.cc
- [docs/BACKUP.md](docs/BACKUP.md) — backups, verification, moving to another machine

**How it works**

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — the SOVRGN protocol: versioning, capabilities, discovery
- [docs/adr/](docs/adr/) — architecture decision records, including the ones later reversed

**Security**

- [SECURITY.md](SECURITY.md) — reporting, what's protected, what isn't
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — threats, mitigations, residual risk
- [docs/SECURITY_ARCHITECTURE.md](docs/SECURITY_ARCHITECTURE.md) — mechanisms: token formats, lifetimes, key caching

**Where it's going**

- [docs/ROADMAP.md](docs/ROADMAP.md) — milestones 0.4 through 0.7
- [docs/AUDIT.md](docs/AUDIT.md) — current state of the codebase: what works, what's broken, what's missing
- [docs/TESTING.md](docs/TESTING.md) — what each test layer proves, and what still isn't checked

## License

MIT
