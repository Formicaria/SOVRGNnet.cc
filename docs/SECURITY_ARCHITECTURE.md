# Security architecture

*How* the security-relevant machinery works. Three documents, three jobs:

- [SECURITY.md](../SECURITY.md) — policy: how to report, what's supported
- [THREAT_MODEL.md](THREAT_MODEL.md) — threats, mitigations, residual risk
- **This document** — mechanisms, formats, and lifetimes as implemented

Written against the code. Where something is weaker than it could be, it says
so rather than omitting it.

---

## Passwords

scrypt via `node:crypto` — no native dependency, so an install never fails on a
missing build toolchain.

```
scrypt:16384:8:1:<16-byte hex salt>:<64-byte hex hash>
```

Parameters are stored in the record, so they can be raised later without
invalidating existing passwords. Salt is per account, 16 random bytes.
Comparison is `timingSafeEqual`. Any malformed record verifies as false rather
than throwing.

Instances that use SSO exclusively store no password at all.

## Sessions

An HS256 JWT signed with `JWT_SECRET`, carrying only `sub` (the integer user
id), in a cookie that is `httpOnly`, `SameSite=Lax`, `path=/`, and `Secure`
whenever the request arrived over HTTPS — including behind a proxy, via
`X-Forwarded-Proto`.

`SameSite=Lax` rather than `None` because the app is same-origin, and because
browsers reject `None` without `Secure`, which would break `http://localhost`
development.

**Sessions are stateless and live one year.** Two consequences worth stating
plainly:

- **Logout clears the cookie but does not invalidate the token.** Anyone
  holding a copy can keep using it until it expires.
- **There is no server-side revocation.** Rotating `JWT_SECRET` invalidates
  every session at once — the only lever available today.

A session table with per-device revocation is the fix, and it is a known gap.

## Authorization

Roles are ranked and checked server-side on every mutation. Two invariants hold
regardless of what any client displays:

1. You may only act on someone **strictly below** you.
2. You may never grant a role **at or above** your own.

Moderators may delete messages but never edit them — editing someone else's
words under their name is a different power than removing them, and the
distinction is enforced rather than assumed.

Bans are recorded in the application database as well as on Matrix, so
discovery and invite links can't route around them.

The **first account registered on an instance becomes its administrator**. Every
instance therefore has at least one local administrator who does not depend on
any external service.

## Registration and join policy

`canRegister()` gates signup against the instance's join policy — open, invite,
or closed — with one exception: the very first account is always allowed,
because the default policy is invite-only and there would otherwise be nobody
to issue the first invite.

Login is rate limited to **10 attempts per IP + email per 15 minutes**, in
process memory. Responses are identical whether or not the account exists.

Most other API surface is not rate limited. That is a gap.

## Matrix

Public registration on the homeserver is **disabled outright**. Accounts are
created only through Synapse-compatible shared-secret registration:

```
GET  /_synapse/admin/v1/register        → nonce
POST /_synapse/admin/v1/register        → HMAC-SHA1(secret, nonce\0user\0pass\0notadmin)
```

Null-separated fields, HMAC keyed with `MATRIX_SHARED_SECRET`, which lives only
in the app process. The nonce is server-issued and single-use, so a captured
registration request can't be replayed.

Each user's Matrix access token is held server-side in `userProfiles` and
**never sent to a browser**. The desktop client stores its instance credentials
in the OS keychain, not in browser storage.

### Device-scoped sessions

Every login carries a `device_id` and a display name. The instance's own
session uses a fixed, recognisable device (`SOVRGNNET_SERVER`, "SOVRGNnet
server"), so re-authenticating after a lost token *replaces* that session
rather than adding another beside it — homeservers previously accumulated one
anonymous device per recovery.

Sessions are listable and individually revocable from account settings, through
the user's own token rather than the admin API, so the list reflects what that
user can actually see and act on.

Which device belongs to the instance is determined by asking the homeserver
(`/account/whoami`) rather than by comparing against a known id. Accounts
created through shared-secret registration land on a device the homeserver
names itself, so a fixed constant only ever matched accounts that had gone
through the login path — and for everyone else the instance's session was
neither flagged nor protected. The instance's session is shown and flagged,
not hidden: the server does hold one, and concealing it would be the dishonest
option. Signing it out is refused, because it would break every operation the
server performs on that user's behalf and would present as the account silently
failing.

### The instance can log in as any user

Matrix passwords are derived — `HMAC(app secret, "matrix-account:<id>")` — so a
lost token is always recoverable and no plaintext password is stored. The cost
is that whatever computes the HMAC can authenticate as anyone, which means
revoking a device does not lock the instance out.

While messages are plaintext this adds nothing an operator couldn't already do.
It becomes decisive under E2EE, and it is recorded as T17 rather than left to
be discovered when the encryption claim is made. See
[ADR 0008](adr/0008-client-side-matrix.md).

## Files

Uploads are membership-checked, capped at 50 MB, and pinned to the instance's
own IPFS node. Downloads stream back **through the application** with a
membership check on every request — not from a public gateway — so CIDs never
leak outside the channel they were shared in.

Content addressing means altered bytes produce a different CID, so integrity is
structural rather than enforced.

## Identity tokens (optional SSO)

Only relevant on instances that set `INSTANCE_ALLOW_SSO=true`. Left unset, the
instance never contacts an identity provider at all.

**Format.** Ed25519-signed JWT, minted by the identity provider, built with
`node:crypto` directly rather than a JWT library — one less dependency in the
most security-sensitive path.

**Lifetime: 300 seconds.** Long enough to complete a sign-in, short enough that
an intercepted token is nearly worthless.

**Audience binding.** Every token names exactly one instance, identified by
`server.id` — the first 16 hex characters of SHA-256 over the Matrix server
name. Reproducible, survives a database restore, and unforgeable without also
taking the server name. A token minted for one instance is rejected by every
other.

**Replay.** Each token carries a unique `jti`. Instances do not yet track seen
values, so a token could in principle be replayed inside its five-minute window
by someone who already intercepted it. Known gap.

### Key caching — the sovereignty guarantee

Instances verify signatures against a **cached** JWKS. When a refresh fails,
the cache logs the failure and **keeps serving the keys it already has,
indefinitely**:

- The identity provider going down blocks new SSO sign-ins.
- It logs nobody out.
- It does not touch local accounts.
- A failed refresh never half-empties a working cache.

This behaviour has tests. An instance that fails closed when a central service
is unreachable isn't sovereign, whatever the marketing says.

### Account linking

Automatic linking of a provider identity to an existing local account requires
a **provider-verified** email. Unverified addresses refuse to link and require
signing in locally first. GitHub's profile email is never trusted — only
verified addresses from `/user/emails`. An email already bound to a different
identity refuses outright.

### Why device flow on desktop

The desktop app signs in with **OAuth device flow**, not a redirect.

`sovrgn://` scheme registration is unauthenticated on every operating system —
any installed application can claim it. A redirect-based flow would put a
sign-in token into a URL that another program can intercept. Device flow never
puts a token in a URL at all: the app shows a code, the browser authenticates
separately, and the app polls for the result.

Device codes are single-use and deleted on redemption.

The web redirect flow, where it is used, derives the token's audience by
fetching `/api/instance` from the return origin — so a token can only ever be
minted for the instance actually receiving it — and returns it in the URL
**fragment**, which never reaches a server or a log.

## Network exposure

| Service | Binding |
|---|---|
| Application | Public, over HTTPS |
| Homeserver client API | Proxied by the app; public only with `clientMatrix` |
| Homeserver admin API | Loopback |
| PostgreSQL | Loopback |
| IPFS admin API | Loopback |

Cloudflare Tunnel, where used, is outbound-only — nothing listens on the WAN.
Native installs run each service as a separate unprivileged systemd unit with
`ProtectSystem=strict`.

A plain-HTTP LAN deployment has no transport encryption. That is the documented
trade-off of the LAN-only option, and it is why that option is LAN-only.

## What is and isn't encrypted

**Message contents, in a channel nobody encrypted.** Plaintext in the
instance's database and homeserver; whoever operates the instance can read
everything. This is the default state of every channel.

**Message contents, in an encrypted channel.** Megolm, since ADR 0008 stage 4.
Keys live on members' devices, the homeserver holds ciphertext, and the
instance's index stores those rows content-blind. Room keys are withheld from
any device its owner has not cross-signed
(`globalBlacklistUnverifiedDevices`), which is what limits the operator's
ability to mint a device and collect keys (T17, T20).

**Metadata, in every channel.** Not encrypted, and not encryptable in this
design: membership, timing, and who spoke are how the index works.

**Backups.** `0600`, and encrypted at rest when `SOVRGN_BACKUP_PASSPHRASE` is
set (scrypt + AES-256-GCM). Without it they are plaintext and contain every
message and every secret — treat one as password material.

**The browser's crypto store.** Unencrypted in IndexedDB (T21). The access
token is not stored at all.

`e2eeAvailable()` in `server/instance.ts` derives the capability from three
conditions — the build ships crypto, a homeserver answered at the advertised
address, and the appservice is wired — and the rule itself lives in
`shared/e2ee.ts` where it is unit-tested. It was a hard-coded `false` while
stage 4 was outstanding, and before that it was briefly derived from whether
the homeserver had a public URL, which would have made an instance claim
encryption the moment it got a public address. The current form is the same
lesson applied forwards: no environment variable sets any of the three.

## Known gaps

Restated together so they aren't scattered:

1. Encryption is per channel and off by default; metadata is never encrypted
2. The instance can log in as any user, and must cooperate in cross-signing
   setup — both from derived Matrix passwords (T17, T20)
3. No server-side session revocation; sessions live a year
4. No 2FA on local accounts
5. Backups unencrypted at rest
6. No `jti` replay tracking
7. Rate limiting on login only
8. No audit log of administrative actions
9. No independent security audit — careful review is not an audit
