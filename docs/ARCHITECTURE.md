# Architecture

<<<<<<< HEAD
## Overview

SOVRGNnet is a thin, opinionated layer over open protocols. The app owns identity, community structure, and UX; Matrix owns message transport and federation; IPFS owns file content.

```
                        ┌────────────────────────────────────────────┐
                        │                nginx (TLS)                 │
=======
How the pieces fit together, as built. Where something is planned rather than
present it says so.

## Terminology

Used consistently throughout the docs, because the words overlap badly if left
loose:

| Term | Means |
|---|---|
| **Instance** | One deployment — app, database, homeserver, IPFS, on one operator's hardware. The unit of sovereignty. |
| **Community** | A space *inside* an instance. What Discord calls a server. |
| **Channel** | A room inside a community. |
| **Client** | The Tauri desktop app, or the web UI an instance serves. |
| **Identity provider** | The optional, separately deployed SSO broker. |

"Server" is ambiguous — it means both the machine and the Discord-style
community — so the docs avoid it in favour of the two words above. **The
database still calls communities `servers`** (`servers`, `serverMembers`,
`serverBans`). Renaming tables is a migration with real risk and no user-visible
benefit, so the schema keeps the old name and the documentation carries the
distinction.

## Layers

SOVRGNnet is a thin, opinionated layer over open protocols. Each layer owns
something specific, and keeping the boundary sharp is what stops the project
reimplementing Matrix badly inside its own database.

- **SOVRGN** — instance identity, capabilities, accounts, membership, roles,
  permissions, moderation, invites.
- **Matrix** — message transport, rooms, events, sync, federation, and (future)
  message encryption.
- **IPFS** — content addressing and media distribution.

The full contract is in [PROTOCOL.md](PROTOCOL.md). PostgreSQL is
*implementation state*, not part of the contract.

## One instance

```
                        ┌────────────────────────────────────────────┐
                        │      TLS: nginx, Cloudflare, or none       │
>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
                        │   sovrgnnet.cc      matrix.sovrgnnet.cc    │
                        └───────┬────────────────────┬───────────────┘
                                │                    │
                    ┌───────────▼──────────┐  ┌──────▼───────┐
<<<<<<< HEAD
                    │  SOVRGNnet app       │  │   Conduit    │
                    │  Express + tRPC      │──▶  (Matrix     │
                    │  serves React client │  │  homeserver) │
                    └───┬──────────────┬───┘  └──────────────┘
                        │              │
                 ┌──────▼─────┐  ┌─────▼──────┐
                 │ PostgreSQL │  │ IPFS (Kubo)│
                 │  (Drizzle) │  │  pin/serve │
                 └────────────┘  └────────────┘
```

All five services run from one Docker Compose file on a single host.

## The mapping model

SOVRGNnet concepts map onto Matrix primitives, with our Postgres as the index:

| SOVRGNnet | Matrix | Postgres table |
|---|---|---|
| User | Matrix account (provisioned server-side) | `users` + `userProfiles.matrixUserId` |
| Server (community) | Space | `servers.matrixRoomId` |
| Channel | Room in the space | `channels.matrixRoomId` |
| Message | Room event | `messages.matrixEventId` |
| File share | IPFS CID referenced in an event | `fileShares.ipfsHash` |

Postgres is the source of truth for app-level structure (membership, roles, metadata, fast listing); Matrix is the source of truth for message content and delivery. The server keeps them consistent — the browser never talks to Conduit directly.

## Request flow

The React client speaks only tRPC (`/api/trpc`). Protected procedures resolve the session cookie / bearer token to a DB user in `createContext`. Matrix operations are proxied: the server holds each user's Matrix access token and acts on their behalf against Conduit over the internal Docker network. Live updates flow back to clients through a server-side sync bridge (WebSocket/SSE) — planned in Phase 2.

## Key server modules

`server/_core/index.ts` boots Express, mounts tRPC, and serves the built client (Vite middleware in dev). `server/_core/context.ts` + `supabaseAuth.ts` resolve the authenticated user (being replaced by first-party auth — see ROADMAP Phase 1). `server/routers.ts` is the whole API surface. `server/db.ts` wraps Drizzle queries; `drizzle/schema.ts` defines the schema and relations. `shared/` holds constants and types used by both sides.

## Design decisions

**Why a homeserver proxy instead of matrix-js-sdk in the browser?** Earlier commits tried a browser Matrix client; it fought CORS, connection state, and localhost coupling. Proxying through our server gives one identity system, server-enforced permissions, and no homeserver exposure to the public internet beyond federation. The trade-off — the server can read plaintext — is acceptable pre-E2EE and revisited when Olm/Megolm lands (Phase 6).

**Why keep Postgres at all if Matrix stores messages?** Listing "my servers," role checks, profiles, and file metadata are relational queries Matrix answers poorly. The index also lets us swap or upgrade the homeserver without losing app structure.

**Why Conduit over Synapse?** Single Rust binary, tiny footprint, fits the self-hosted/ARM64 (Pi 5) target. Synapse remains a drop-in alternative if we hit feature ceilings (e.g., appservice quirks).
=======
                    │  SOVRGNnet app       │  │   Dendrite   │
                    │  Express + tRPC      │──▶  (Matrix     │
                    │  serves React client │  │  homeserver) │
                    └───┬──────────────┬───┘  └──────┬───────┘
                        │              │             │
                 ┌──────▼─────┐  ┌─────▼──────┐ ┌────▼─────┐
                 │ PostgreSQL │  │ IPFS (Kubo)│ │ Postgres │
                 │  (Drizzle) │  │  pin/serve │ │ (matrix) │
                 └────────────┘  └────────────┘ └──────────┘
```

Four services on one host, via Docker Compose or as plain systemd units
([LXC.md](LXC.md)). Postgres, the homeserver admin API, and the IPFS admin API
bind to loopback; only the app is reachable from outside.

## The network

```
      Instance A          Instance B          Instance C
      (a VPS)             (a home NAS)        (someone's laptop)
           └───────────────────┼───────────────────┘
                        SOVRGNnet Client
                    one session per instance
```

Instances do not depend on each other, and none depends on sovrgnnet.cc. The
client holds a separate session per instance, in the OS keychain. Federation
between homeservers is possible but off by default and untested — see the
roadmap.

## The mapping model

| SOVRGN concept | Matrix primitive | Postgres table |
|---|---|---|
| User | Matrix account, provisioned server-side | `users` + `userProfiles.matrixUserId` |
| Community | Space | `servers.matrixRoomId` |
| Channel | Room in the space | `channels.matrixRoomId` |
| Message | Room event | `messages.matrixEventId` |
| Edit / reaction | `m.replace` / `m.annotation` | — |
| File share | IPFS CID referenced in an event | `fileShares.ipfsHash` |

Postgres is authoritative for app structure — membership, roles, metadata, fast
listing. Matrix is authoritative for message content and delivery. Keeping the
index means the homeserver can be upgraded, or swapped, without losing app
structure.

## Request flow

The React client speaks tRPC at `/api/trpc`. Protected procedures resolve the
session cookie or bearer token to a database user in `createContext`.

Matrix operations are **proxied**: the app holds each user's Matrix access token
and acts on their behalf over the internal network. The browser never talks to
Dendrite. Live updates are a 3-second poll — a real `/sync` stream arrives with
client-side Matrix.

Files go over REST rather than tRPC, because tRPC is a poor fit for streaming
bytes. `POST /api/upload` pins to the local IPFS node after a membership check;
`GET /api/files/:cid` streams back through the app, also membership-checked, so
CIDs never leak outside a channel.

## Discovery endpoints

Unauthenticated and CORS-open, because a client connecting to an instance it
has never seen has no credentials yet:

```
GET /api/instance      descriptor: protocol, capabilities, identity
GET /api/capabilities  cheap to poll
GET /api/version       versions, for humans
GET /health            liveness — deliberately does not touch the database
GET /ready             readiness — per-dependency
```

`/health` staying off the database is the point: it distinguishes "the app is
down" from "the database is down", which is the first question during an
incident.

## Modules

**`server/_core/`** — Express boot, tRPC setup, session cookies, environment
parsing, Vite middleware in development.

**`server/routers.ts`** — the entire tRPC surface: auth, communities, channels,
messages, members, roles, moderation, invites, files.

**`server/instance.ts`** — instance identity, the capability descriptor, join
policy. `E2EE_AVAILABLE` is a hard-coded constant here, not derived from
configuration, so no environment variable can make the instance claim
encryption it doesn't have.

**`server/matrixService.ts`** — homeserver REST client. Provisions accounts via
Synapse-compatible shared-secret registration; public registration on the
homeserver is disabled outright.

**`server/ipfsService.ts`** — Kubo API client. Pins to the instance's own node.

**`server/sso.ts`** — verifies identity tokens against cached JWKS. Serves stale
keys indefinitely rather than failing closed, so an identity provider outage
never logs anyone out.

**`server/migrate.ts`** — applies pending migrations at boot. There is no
migration step to forget.

**`shared/protocol.ts`** — the protocol contract, shared by client and server so
they cannot drift.

**`desktop/`** — Tauri 2. One webview per connected instance, credentials in the
OS keychain, `sovrgn://` deep links, update check on launch.

**`identity/`** — the optional identity provider. Deploys separately, on purpose:
an instance must not depend on it being on the same box, or on being up at all.

## Design decisions

Fuller reasoning, including decisions later reversed, is in [`adr/`](adr/).

**Why proxy Matrix instead of running the SDK in the browser?** Early commits
tried a browser Matrix client and fought CORS, connection state, and localhost
coupling. Proxying gives one identity system, server-enforced permissions, and
no homeserver exposure. The cost is that the app reads plaintext — acceptable
only until E2EE, at which point this inverts and the client owns the session.

**Why keep Postgres if Matrix stores messages?** Listing someone's communities,
checking roles, and querying file metadata are relational questions Matrix
answers poorly. The index also decouples app structure from the homeserver.

**Why Dendrite?** Second-generation Matrix homeserver from the Matrix.org team,
written in Go, far lighter than Synapse and ARM64-friendly. It replaced Conduit,
which had a smaller footprint but incomplete Spaces support — and Spaces are how
communities are modelled, so that was disqualifying. Dendrite ships no
prebuilt binaries, so the native install builds it from source. See
[ADR 0006](adr/0006-dendrite-replaces-conduit.md).

**Why is the identity provider separate?** Because an instance that needs it to
boot isn't sovereign. It deploys on its own host, SSO is off by default, and
every instance keeps local accounts and at least one local administrator so it
can never be locked out of itself.

**Why capabilities default to false?** An instance that has never heard of a
capability must read as "doesn't have it", never "probably fine". Optimistic
defaults are how a client ends up offering a feature that silently does nothing.
>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
