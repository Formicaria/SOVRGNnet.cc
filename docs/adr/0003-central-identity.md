# ADR 0003 — One account, issued by sovrgnnet.cc

**Status:** Accepted · August 2026
**Amends:** [ADR 0001](0001-multi-server-client.md)

## Context

Every server issues its own accounts. Joining five friends' servers means five
sign-ups and five passwords. Discord doesn't work that way and neither should
this — the friction is real and it lands hardest on exactly the non-technical
people the installer work was meant to serve.

The decision: **sovrgnnet.cc issues identities, and servers accept them.** You
sign up once on the website, then use that account to sign in to any server,
including one you build yourself.

## What this costs, stated plainly

This is centralisation, in the part of the system where it matters most.

- **sovrgnnet.cc becomes infrastructure for other people's servers.** A server
  running on someone's laptop now depends on a domain they don't own for its
  sign-in flow.
- **It is a single point of failure**, and a single point of censorship.
  Whoever controls sovrgnnet.cc can deny an identity, and therefore deny
  access to servers they have nothing to do with.
- **It sees the network.** Every login, and by inference which servers a person
  belongs to, becomes visible to the identity service.
- **It carries liability.** Accounts get abused; the operator of the identity
  service is the party who receives the complaints.

Alternatives were considered and rejected: portable keypair identity (same
end-user experience, no central dependency, but requires recovery-phrase
handling that non-technical users lose), and per-server accounts held in the
desktop client's keychain (no new centralisation, but not genuinely one
identity and no help to browser users).

**This ADR contradicts claims made elsewhere in this repository** — including
ADR 0001's "an unregistered server stays fully functional" and marketing copy
about no company in the middle. Those must be corrected rather than left
standing. A project that argues for sovereignty while quietly centralising
authentication is doing the thing it criticises.

## Decision

sovrgnnet.cc runs an identity provider issuing short-lived, **asymmetrically
signed** tokens. Servers verify them against a public key they fetch and cache.

The asymmetry is the whole design. A shared secret would mean every server
calls sovrgnnet.cc on every login, making it a hard runtime dependency. Public
key verification means a server needs the key *once* and can then verify
tokens entirely offline.

```
  person → sovrgnnet.cc      sign in, receive a signed token
  person → their server      present the token
  server                     verify signature against its cached public key
  server                     find or create a local user row for that subject
```

Three properties follow, and they're the reason for this shape:

1. **A server that has cached the key verifies tokens with sovrgnnet.cc
   completely unreachable.** Existing sessions and anyone holding an unexpired
   token keep working through an outage.
2. **Local password accounts continue to exist and continue to work.** SSO is
   an additional way in, never the only one. Every server keeps at least one
   local administrator, so no instance can be locked out of itself.
3. **Servers may refuse SSO entirely.** `INSTANCE_ALLOW_SSO=false` makes an
   instance local-accounts-only, and it stays fully functional. This is the
   escape hatch that keeps the sovereignty claim honest for anyone who wants
   it.

Tokens are short-lived. Servers cache the signing key with a long TTL and
deliberately keep serving a stale key rather than failing closed — a signature
check against a key that rotated last week is a far smaller problem than every
server on the network refusing logins because one HTTP request failed.

## Consequences

**A new service to run, forever.** The identity provider is now
production infrastructure with uptime expectations set by everyone else's
servers. It needs its own database, backups, monitoring, and an answer for
account recovery.

**Key rotation is a protocol event.** Rotating the signing key invalidates
tokens on servers that haven't refreshed. It needs overlapping validity and a
key ID on every token, which is why one is included from the start rather than
retrofitted.

**Account linking needs care.** A person may already have a local account on a
server and then sign in with SSO. Matching them by email address is the
obvious approach and is unsafe unless the identity provider verifies email
ownership — otherwise registering an SSO account with someone else's address
would take over their local account. Linking is therefore explicit: signed in
locally first, then linked, or it creates a separate account.

**We are now a target.** An identity service holding the keys to a network of
servers attracts attention that a chat app does not.

## Per-server profiles

One identity does not mean one face. Each membership carries an optional
nickname and avatar, so the same account is "Zach" in one community and
"chronus" in another — the way Discord handles it, and the thing that makes a
single identity tolerable rather than flattening.

Resolution is deliberately small and in one place: nickname if set, account
name otherwise, and a nickname of whitespace counts as unset rather than
rendering a message with a blank author.

## Status of the implementation

Landed: the schema (`users.ssoSubject`, `serverMembers.nickname`/`avatar`),
per-server profile resolution across messages and member lists, and the
profile API.

**Not built yet: the identity provider itself.** sovrgnnet.cc does not issue
tokens, no server verifies them, and `auth.ssoLogin` does not exist. Until
that ships, every account is a local one and nothing in this ADR affects a
running instance. The corrections listed below become due when the provider
does, not before — stating them now would be its own kind of dishonesty.

## What must be corrected elsewhere

- ADR 0001's claim that an unregistered server is fully functional
- Landing page and docs copy implying no central dependency
- `docs/LXC.md` and `QUICKSTART.md`, which describe an instance as
  self-contained

These are tracked as part of implementing this ADR, not as follow-up.
