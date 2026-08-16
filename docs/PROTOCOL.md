# The SOVRGN protocol

The contract between any client and any instance.

Versioned **separately from the application**, deliberately. Independently
operated instances upgrade on their own schedule — not on this project's
release cadence — and requiring them to move in lockstep would make every
instance quietly dependent on us. That is the thing this architecture exists to
prevent.

```
SOVRGNnet Server:   0.3.0     ← application
SOVRGNnet Client:   0.3.0     ← application
SOVRGN Protocol:    1.0       ← the contract
```

Implementation: [`shared/protocol.ts`](../shared/protocol.ts), with tests in
`server/protocol.test.ts`.

## What belongs to whom

Getting this boundary wrong is how a project ends up reimplementing Matrix
badly inside its own database.

| Concern | Owner |
|---|---|
| Instance identity, configuration, capabilities | **SOVRGN** |
| User profiles, membership, roles, permissions | **SOVRGN** |
| Moderation, invites, discovery | **SOVRGN** |
| Messages, rooms, events, sync, presence, typing | **Matrix** |
| Device sessions, message encryption, federation | **Matrix** |
| Content addressing, media distribution, pinning | **IPFS** |

The PostgreSQL schema is *implementation state* — an instance may store it
however it likes. This protocol is the interoperability layer.

## Versioning

```
major.minor      e.g. 1.0
```

**Major** changes break compatibility. A client speaking major 1 cannot talk to
an instance speaking only major 2, in either direction.

**Minor** changes only add capabilities and are always backward compatible. An
older party doesn't know about the additions and never asks for them.

Compatibility is a single rule — **same major version** — and nothing else.
Application versions are informational and must never gate a connection.

```ts
checkCompatibility({ major: 1, minor: 7 }, { major: 1, minor: 0 })
// ok — instance is newer, client just won't use the additions

checkCompatibility({ major: 1, minor: 0 }, { major: 2, minor: 0 })
// refused: "server-too-old" — its operator needs to update
```

## Discovery

```
GET /api/instance      full descriptor
GET /api/capabilities  protocol + capabilities only, cheap to poll
GET /api/version       versions, for humans
GET /health            liveness — does not touch the database
GET /ready             readiness — per-dependency status
```

All are unauthenticated and CORS-open. They must be: a client connecting to an
instance it has never seen has no credentials yet, and cross-origin is the
entire point of a multi-instance client.

None of them expose members, channels, or message data.

### Descriptor

```json
{
  "product": "sovrgnnet",
  "protocol": { "major": 1, "minor": 0 },
  "server": {
    "version": "0.3.0",
    "id": "abc123def4567890",
    "name": "Zach's instance",
    "description": null
  },
  "capabilities": {
    "messaging": true,
    "media": true,
    "e2ee": false,
    "voice": false,
    "federation": false,
    "sso": false,
    "publicRegistration": false,
    "clientMatrix": false,
    "portableBackup": true
  },
  "matrix": { "serverName": "sovrgnnet.cc", "baseUrl": null },
  "joinPolicy": "invite",
  "identityIssuer": null
}
```

`product` exists so a client pointed at the wrong address can say "that isn't a
SOVRGNnet instance" rather than failing at a login screen.

`server.id` is **exactly 16 lowercase hex characters**: SHA-256 of
`sovrgnnet:instance:<matrix server name>`, truncated. Reproducible, survives a
database restore, and can't be forged without also taking the server name.

The format is normative rather than cosmetic, because the id is the audience of
every identity token minted for this instance. An ambiguous audience value is a
security problem — two instances that could both plausibly claim the same
token — not a style preference.

### Health and readiness

`/health` answers **without touching the database**, and `/ready` answers by
actually round-tripping a query. Keeping them distinct is the whole point: a
liveness probe that fails when Postgres fails can't tell you whether the app is
down or the database is, which is the first question at 3am, and it makes
orchestrators restart a perfectly healthy process.

`/ready` returning 503 is a correct answer, not a violation. An instance
honestly reporting itself as degraded is conforming.

## Capabilities

Every capability **defaults to false**. That direction is the whole design: an
older instance that has never heard of a capability must read as "doesn't have
it", never as "probably fine". Optimistic defaults are how a client ends up
offering a feature that silently does nothing.

| Capability | Means |
|---|---|
| `messaging` | Text messaging. Every instance. |
| `media` | File sharing through the instance's storage. |
| `e2ee` | End-to-end encryption. **False everywhere today.** |
| `voice` | Voice and video channels. |
| `federation` | The homeserver talks to other Matrix servers. |
| `sso` | Accepts identities from an identity provider. |
| `publicRegistration` | Anyone may sign up without an invite. |
| `clientMatrix` | Clients may sync with Matrix directly. |
| `portableBackup` | Can produce and consume portable backups. |

Ask through `supports()` rather than reading the flag, so a descriptor missing
the field degrades correctly:

```ts
if (supports(descriptor, "voice")) showVoiceChannels();
else explain(explainMissing("voice"));
```

Degrading gracefully means **explaining, not hiding**. Someone whose friend's
instance has no voice should learn that, not wonder where the button went.

## Compatibility policy

- New capabilities arrive in **minor** versions and default to false.
- Removing or changing the meaning of a capability requires a **major** bump.
- `/api/instance` currently serves both the v0.1–v0.3 field layout and the
  formal descriptor in one response, so existing clients keep working. The old
  fields are deprecated but will not be removed inside major version 1.
- An instance must never require a client to be newer than the protocol
  demands.

## Writing another implementation

Anything serving these endpoints, honouring capability negotiation, and
implementing SOVRGN's side of authentication, membership, roles, and invites is
a SOVRGNnet instance. Nothing about this repository's language, framework, or
database is normative.

### Checking it

```bash
pnpm conformance https://your-instance.example
pnpm conformance http://localhost:3000 --json
```

Exit code 0 means it conforms. Warnings never fail it — they're advice.

The suite checks the protocol surface only: discovery, versioning, capability
negotiation, and self-consistency. It needs no credentials, so it's safe to
point at someone else's instance.

Self-consistency is the part worth having. A descriptor is a set of promises a
client acts on, and two promises that can't both be true mean the client does
something wrong while the operator never sees why:

| Contradiction | Why it's caught |
|---|---|
| `publicRegistration` with a non-open join policy | Clients offer a signup form the instance refuses |
| `e2ee` without `clientMatrix` | If the instance proxies all Matrix traffic it holds the keys — this claims a protection it structurally cannot provide |
| `clientMatrix` with no `matrix.baseUrl` | Clients are told to sync directly and given nowhere to sync to |
| `sso` with no `identityIssuer` | No provider to send anyone to |
| Members, channels, or messages in `/api/instance` | That endpoint is unauthenticated and public |

Checks live in [`shared/conformance.ts`](../shared/conformance.ts) as pure
functions over already-fetched responses, so they're tested without a server.
`scripts/conformance.ts` only does the I/O.

The reference implementation passes its own suite — verified by running it
against a live process, which is how the readiness endpoint was found reporting
`database: "ok"` with no database.
