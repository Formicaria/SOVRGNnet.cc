# Threat model

What SOVRGNnet defends against, what it doesn't, and what is simply true about
running communications infrastructure yourself.

Written against the **implementation as it exists**, not the roadmap. Where a
mitigation is planned rather than built, it says so. A threat model that
describes intentions is worse than none, because people make decisions on it.

Last reviewed: v0.4.0 development.

---

## The single most important fact

**Messages are not end-to-end encrypted.** They are stored as plaintext in the
instance's database and homeserver. Everything below follows from that: the
instance operator is inside your trust boundary, not outside it.

Client-side encryption is the next architectural milestone. Until it ships, no
threat involving "someone with access to the instance" has a technical
mitigation — only a social one, which is that you chose who runs it.

---

## Trust boundaries

```
  ┌─────────────────────────────────────────────┐
  │ Instance operator                           │  ← full access to everything
  │  ┌───────────────────────────────────────┐  │
  │  │ Instance (app + Postgres + Dendrite   │  │
  │  │           + IPFS)                     │  │
  │  └───────────────────────────────────────┘  │
  └─────────────────────────────────────────────┘
            ▲                        ▲
            │ member                 │ optional
            │                        │
      ┌───────────┐          ┌──────────────────┐
      │  Client   │          │ Identity provider │ ← sees sign-ins, not content
      └───────────┘          └──────────────────┘
```

Everything inside the outer box is one trust domain. The identity provider is
outside it and deliberately kept ignorant.

---

## Threats

### T1 — Malicious or curious instance operator

**Capabilities:** Full database and homeserver access. Can read every message,
impersonate any member, alter history, and read files.

**Affected:** Everything on that instance.

**Mitigations:** None technical, today. The interface states plainly that
messages are readable by whoever runs the instance — on the login page, in the
add-server dialog, and in the docs — so the choice is informed. Per-server
identity limits blast radius to that one community.

**Residual risk: total, and by design for now.** Choosing whose instance you
join *is* the security decision. E2EE moves this from "trusted" to "cannot
read message contents", and nothing else in this document changes as much.

---

### T2 — Compromised instance

**Capabilities:** As T1, plus modifying the served client to exfiltrate what
members type.

**Affected:** That instance and its members.

**Mitigations:** Homeserver and IPFS admin APIs bind to loopback. Public
homeserver registration is disabled entirely; accounts are created only via a
shared secret held in the app process. Services run as separate unprivileged
users with `ProtectSystem=strict`. Log rotation limits disk exhaustion.

**Residual risk: high.** A compromised instance is a compromised community.
Backups let you rebuild; they don't undo disclosure.

---

### T3 — Compromised identity provider

**Capabilities:** Mint identity tokens for any account, therefore sign in as
anyone on instances that accept it.

**Affected:** Only instances with `INSTANCE_ALLOW_SSO=true`.

**Mitigations:** SSO is off by default and per-instance. Every instance keeps
local accounts and at least one local administrator, so it can never be locked
out of itself. Tokens are audience-bound to a single instance, are short-lived
(5 minutes), and are verified against a **cached** public key — so the provider
cannot silently substitute a key without instances fetching JWKS again.

**Residual risk: high for participating instances.** This is the cost of the
convenience, stated in ADR 0003. An operator who declines SSO is unaffected.

---

### T4 — Identity provider unavailable

**Capabilities:** N/A — availability failure.

**Mitigations:** Servers cache signing keys and **keep serving stale keys
indefinitely** rather than failing closed. Existing sessions are unaffected;
only new SSO sign-ins fail. Local accounts continue working.

**Residual risk: low.** This is the sovereignty guarantee, and it has tests.

---

### T5 — Server impersonation via a malicious invite

**Capabilities:** Send an invite that points at an attacker's instance.

**Mitigations:** Invites carry a host; the client fetches `/api/instance` and
shows the instance name, Matrix server name, and encryption status *before*
anyone types a password. Non-SOVRGNnet addresses are refused outright.

**Residual risk: moderate.** A convincing name is still convincing. This is
phishing, and the defence is showing the address plainly.

---

### T6 — Token theft via redirect hijacking

**Capabilities:** Register a competing `sovrgn://` handler and receive a
sign-in token.

**Mitigations:** The desktop uses **device flow**, not a redirect — no token
ever travels through a URL another application can claim. The web redirect
flow derives the token's audience by fetching `/api/instance` from the return
origin, so a token can only ever be minted for the instance actually receiving
it. Tokens return in the URL fragment, which never reaches a server or a log.

**Residual risk: low.**

---

### T7 — Account takeover through identity linking

**Capabilities:** Register with a victim's email at a provider, then sign in
and inherit their existing local account.

**Mitigations:** Automatic linking requires a **provider-verified** email.
Unverified addresses refuse to link and require signing in locally first.
GitHub's profile email is never trusted for this — only verified addresses
from `/user/emails`. An email already bound to a different identity refuses
outright.

**Residual risk: low.** Tested directly.

---

### T8 — Stolen Matrix access token

**Capabilities:** Act as that user on the homeserver.

**Mitigations:** Tokens are held server-side and never sent to browsers.
Desktop credentials live in the OS keychain, not browser storage.

**Residual risk: moderate.** There is no per-device revocation yet. Device
management arrives with client-side Matrix.

---

### T9 — Privilege escalation inside a community

**Capabilities:** A member tries to act beyond their role.

**Mitigations:** Roles are ranked and checked server-side on every mutation.
Two invariants are enforced regardless of what any client shows: you may only
act on someone strictly below you, and you may never grant a role at or above
your own. Bans are recorded app-side as well as on Matrix, so discovery and
invite links don't route around them. Moderators may delete messages but never
edit them.

**Residual risk: low.** Well covered by tests.

---

### T10 — Compromised IPFS infrastructure

**Capabilities:** Serve altered content for a CID, or observe requests.

**Mitigations:** Files are pinned to the instance's own node. Downloads stream
through the app with membership checks rather than a public gateway, so CIDs
don't leak outside a channel. Content addressing means altered bytes produce a
different CID.

**Residual risk: low for integrity, moderate for availability.**

---

### T11 — Network attacker (MITM)

**Mitigations:** HTTPS for any public address; Cloudflare Tunnel is
outbound-only, so nothing listens on the WAN. Internal service traffic stays
on loopback or a private container network. Identity tokens are signed, so
tampering invalidates them.

**Residual risk: low**, except on a plain-HTTP LAN deployment, where a local
attacker can read traffic. Local installs are LAN-only by design.

---

### T12 — Replay

**Mitigations:** Identity tokens carry a unique `jti` and expire in five
minutes. Device codes are single-use and deleted on redemption. Shared-secret
registration uses a server-issued nonce. Recovery codes are single-use.

**Residual risk: low.** Servers do not yet track seen `jti` values, so a token
could in principle be replayed within its five-minute window by someone who
already intercepted it.

---

### T13 — Credential stuffing

**Mitigations:** scrypt hashing, ten attempts per IP+email per fifteen
minutes, identical responses whether or not an account exists.

**Residual risk: moderate.** No 2FA on local accounts. Signing in through a
provider inherits theirs, which is one of the better arguments for SSO.

---

### T14 — Malicious directory entry

**Status:** The directory does not exist yet. When it does: listing is
opt-in, joining still requires an invite, and it will hold instance addresses
only — never members or messages.

---

### T15 — Stolen session cookie

**Capabilities:** Act as that user on that instance for as long as the token
remains valid.

**Mitigations:** The cookie is `httpOnly`, so page script cannot read it;
`SameSite=Lax`, which blunts CSRF; and `Secure` on any HTTPS request, including
behind a proxy via `X-Forwarded-Proto`.

**Residual risk: moderate.** Sessions are **stateless JWTs with a one-year
lifetime**. Logging out clears the cookie but does not invalidate the token, so
a stolen copy keeps working. The only revocation lever is rotating
`JWT_SECRET`, which logs out every user on the instance. A session table with
per-device revocation is the fix and is not built.

---

### T16 — Backup theft

**Capabilities:** A backup archive contains the entire community and its
secrets.

**Mitigations:** Archives are written `0600`. The docs say plainly to treat
them as password material and to encrypt them if they leave your control.

**Residual risk: high if mishandled.** Backups are not encrypted at rest by
the tooling — an explicit gap, and a good candidate for the next pass.

---

## What an attacker cannot do

- Read messages on an instance they have no access to
- Use an identity token minted for one instance against another
- Sign up on a homeserver directly — public registration is disabled
- Reach Postgres, the homeserver admin API, or the IPFS admin API from outside
- Take over an account by claiming an unverified email
- Escalate to a role at or above the person acting

## Known gaps

1. **No end-to-end encryption.** The largest by a distance.
2. **No session revocation.** Stateless one-year JWTs; logout doesn't invalidate.
3. **No per-device Matrix session revocation.**
4. **No 2FA for local accounts.**
5. **Backups are unencrypted at rest.**
6. **No `jti` replay tracking** within a token's lifetime.
7. **No rate limiting on most API surface** beyond login.
8. **No audit log** of administrative actions.
9. **No independent security audit.** Careful review is not an audit.

## Related

Mechanism-level detail — token formats, lifetimes, key caching behaviour — is
in [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

## Reporting

Email `security@formicaria.us` rather than opening a public issue.
