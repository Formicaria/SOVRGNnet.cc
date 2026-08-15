# ADR 0001 — SOVRGNnet is a network of servers, not a website

**Status:** Accepted · August 2026
**Supersedes:** the server-side Matrix proxy described in ARCHITECTURE.md

## Context

Up to v0.1.0, SOVRGNnet was a web application you self-host. You install it,
people visit it in a browser, and *inside* that one instance you create
"servers" — which are really Matrix Spaces belonging to a single deployment.
One instance, one community cluster, one web origin.

That is not what this project is for. The intended shape is the one Discord
actually has, minus the landlord:

- A **server** is a machine somebody runs. Zach's LXC is one. A friend's box is
  another.
- A **desktop client** connects to *several* of them at once and switches
  between them, the way Discord's left rail switches between guilds.
- You **find** a server by its ID, but you **join** by invite or by whatever
  policy its owner configured.
- The owner configures their server **from the client**, not by editing files
  over SSH.
- Conversations are **end-to-end encrypted**.
- **Voice** works.

Two of those requirements are load-bearing and in direct conflict with the
current design.

### The conflict

Today the app server provisions a Matrix account per user, stores that access
token in its own database, and performs every Matrix operation on the user's
behalf. The browser never touches Matrix. This was a deliberate and, at the
time, correct choice: it puts permission checks in exactly one place, keeps the
homeserver off the public internet, and means one login instead of two.

It also means **the server holds every user's keys and reads every message in
plaintext**. End-to-end encryption is not a feature that can be added to that
design. It is excluded by it. You cannot encrypt a message end-to-end if a
middle party holds both ends' keys — that middle party *is* the end.

The same proxy design also assumes a single instance. A server-side session
belongs to one deployment's database. There is no coherent way for one browser
session to be simultaneously authenticated against four independent people's
servers.

## Decision

**Move the Matrix session into the client.**

The desktop client holds its own Matrix credentials and encryption keys per
server, syncs directly with each homeserver, and encrypts and decrypts locally.
The app server stops being a message proxy and becomes what it should have
been: the thing that knows about *communities* — identity on that instance,
membership, roles, invites, discovery, and file storage.

Concretely:

| Concern | Before | After |
|---|---|---|
| Matrix session | server-held token, server proxies | client-held, client syncs directly |
| Message content | plaintext, server-readable | Olm/Megolm, client-only |
| Permissions | app checks on every call | Matrix power levels, app mirrors for its own surfaces |
| Identity | one account per instance, in the app DB | one account per instance, but the client manages many |
| Servers you're in | rows in one database | connections in the client |
| Discovery | `listPublic` on one instance | opt-in directory at sovrgnnet.cc |
| Invites | a code, implicitly on this instance | a code **plus the server's address** |

The web app remains, and remains useful — but it becomes the **unencrypted
fallback**: fine for a private homelab instance, honest about what it is,
never the surface where E2EE is claimed.

`sovrgnnet.cc` runs an **opt-in directory and invite resolver**. It holds
server IDs, display names, and addresses — never members, never messages.
Registration is voluntary; an unregistered server is fully functional and
simply not searchable. Invite links resolve through it for convenience but
carry the server address themselves, so the directory going away breaks
discovery, not communication.

## Consequences

### What this costs

**The central permission check goes away.** Right now `requireServerRole` is
one function, called on every mutation, and it is genuinely good. Once clients
talk to Matrix directly, Matrix power levels become the enforcement point for
anything touching rooms. The app keeps its own roles for what it still owns —
invites, file uploads, directory listing — and mirrors them into power levels,
but it can no longer be the single gate. This is a real loss of simplicity and
we should not pretend otherwise.

**The homeserver must be reachable by clients.** Conduit currently binds to
loopback, which is a nice security property we lose. It moves behind the
tunnel with proper delegation, and its own auth becomes load-bearing rather
than defence-in-depth.

**Two clients, two capability levels.** Web users can't have E2EE. Every
feature now has to answer "does this work in the browser?" — and sometimes the
answer is no. That's a permanent tax on the roadmap.

**Key management becomes a user-facing problem.** Lost keys mean lost history.
Cross-device verification, key backup, and recovery phrases are not optional
extras once E2EE ships; they're the difference between encryption and data
loss. This is the single most underestimated part of the work.

**Onboarding gets harder.** "Open this link in a browser" becomes "install the
client, then open this link." The web fallback softens it, and the installer
work already done means running a *server* stays easy — but the client story
regresses before it improves.

### What this buys

Messages nobody but the participants can read, including the person running
the server. A client that holds all your communities at once. Servers that are
genuinely independent rather than tenants of one deployment. Voice, which needs
a persistent client anyway. And a project whose claims about sovereignty become
true rather than aspirational.

### What it obsoletes

- The server-side Matrix proxy in `matrixService.ts` / `matrixBridge.ts` — it
  survives for the web fallback and for server-owned operations (provisioning,
  room creation, moderation), but stops being the path for messages.
- `servers.listPublic` as the discovery mechanism.
- The current invite format, which assumes the client already knows which
  instance it's talking to.
- The polling loop in `Dashboard.tsx`, replaced by a real `/sync` stream in the
  client.

## Sequencing

Ordered so each step ships something usable rather than half a rewrite:

1. **Instance identity** — a server can say who it is to a stranger.
2. **Addressable invites** — a link identifies both a server and a code.
3. **Desktop client shell** — Tauri, connection manager, multi-server rail,
   deep links. Wraps today's web UI; no protocol change yet.
4. **Client-side Matrix** — the client syncs directly. Still plaintext.
5. **E2EE** — Olm/Megolm, key backup, device verification.
6. **Voice** — MatrixRTC + LiveKit.
7. **Directory** — opt-in registration and search at sovrgnnet.cc.
8. **Server administration from the client** — settings, roles, moderation.

Steps 1–3 don't break anything that works today. Step 4 is where the pivot
becomes real, and where the web app and the desktop client diverge.

## Alternatives considered

**Keep the proxy, add "encryption" between client and server.** This is
transport encryption with extra steps. It's what most products mean when they
say encrypted, and it would be dishonest here given what the project claims.

**Federate instead of multi-connecting.** Let Matrix federation do the work:
one identity, servers reach each other. Genuinely appealing, and the reason
`MATRIX_SERVER_NAME` is being chosen carefully now. But federation makes every
server's availability and moderation policy everyone else's problem, and it
requires every instance to be publicly reachable — which contradicts "runs on a
laptop in a closet." Multi-connection first; federation stays possible for
those who want it.

**Web client with E2EE.** Technically possible — Element does it. But key
material in browser storage is a materially weaker position than key material
in an OS keychain, and the desktop client is wanted anyway for voice and
notifications. Not worth doing twice, badly.
