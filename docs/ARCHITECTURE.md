# Architecture

## Overview

SOVRGNnet is a thin, opinionated layer over open protocols. The app owns identity, community structure, and UX; Matrix owns message transport and federation; IPFS owns file content.

```
                        ┌────────────────────────────────────────────┐
                        │                nginx (TLS)                 │
                        │   sovrgnnet.cc      matrix.sovrgnnet.cc    │
                        └───────┬────────────────────┬───────────────┘
                                │                    │
                    ┌───────────▼──────────┐  ┌──────▼───────┐
                    │  SOVRGNnet app       │  │   Dendrite    │
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

Postgres is the source of truth for app-level structure (membership, roles, metadata, fast listing); Matrix is the source of truth for message content and delivery. The server keeps them consistent — the browser never talks to Dendrite directly.

## Request flow

The React client speaks only tRPC (`/api/trpc`). Protected procedures resolve the session cookie / bearer token to a DB user in `createContext`. Matrix operations are proxied: the server holds each user's Matrix access token and acts on their behalf against Dendrite over the internal Docker network. Live updates flow back to clients through a server-side sync bridge (WebSocket/SSE) — planned in Phase 2.

## Key server modules

`server/_core/index.ts` boots Express, mounts tRPC, and serves the built client (Vite middleware in dev). `server/_core/context.ts` + `supabaseAuth.ts` resolve the authenticated user (being replaced by first-party auth — see ROADMAP Phase 1). `server/routers.ts` is the whole API surface. `server/db.ts` wraps Drizzle queries; `drizzle/schema.ts` defines the schema and relations. `shared/` holds constants and types used by both sides.

## Design decisions

**Why a homeserver proxy instead of matrix-js-sdk in the browser?** Earlier commits tried a browser Matrix client; it fought CORS, connection state, and localhost coupling. Proxying through our server gives one identity system, server-enforced permissions, and no homeserver exposure to the public internet beyond federation. The trade-off — the server can read plaintext — is acceptable pre-E2EE and revisited when Olm/Megolm lands (Phase 6).

**Why keep Postgres at all if Matrix stores messages?** Listing "my servers," role checks, profiles, and file metadata are relational queries Matrix answers poorly. The index also lets us swap or upgrade the homeserver without losing app structure.

**Why Dendrite over Synapse?** Single Rust binary, tiny footprint, fits the self-hosted/ARM64 (Pi 5) target. Synapse remains a drop-in alternative if we hit feature ceilings (e.g., appservice quirks).
