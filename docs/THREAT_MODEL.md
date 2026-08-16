# Threat model

What SOVRGNnet defends against, what it doesn't, and what is simply true about
running communications infrastructure yourself.

Written against the **implementation as it exists**, not the roadmap. Where a
mitigation is planned rather than built, it says so. A threat model that
describes intentions is worse than none, because people make decisions on it.

Last reviewed: v0.6 development, after ADR 0008 stage 4.

---

## The single most important fact

**Channels are encrypted, unless the instance can't manage it.** There is no
per-channel switch: every channel created on an instance that advertises `e2ee`
is Megolm-encrypted from the moment it exists, and nobody has to know to turn
anything on.

*What "can't manage it" means* is two conditions, both about the deployment
rather than the software. A homeserver has to be reachable by clients, because
otherwise the only place a member's keys could live is the server — which is
the arrangement encryption exists to end. And the instance has to record what
its homeserver pushes, or an encrypted message is not unreadable to other
members, it is absent. The default LXC install produces a loopback homeserver
and therefore plaintext channels; it says so through the `e2ee` capability, and
a client that reads capabilities will tell you.

*In a plaintext channel* — one created before this, or on an instance that
can't offer encryption — messages are stored readable in the instance's
database and homeserver. The operator is inside your trust boundary, not
outside it, and no threat involving "someone with access to the instance" has a
technical mitigation. Only a social one: you chose who runs it.

*In an encrypted channel* — Megolm, since ADR 0008 stage 4 — the instance holds
ciphertext it has no key for, and its own index stores those messages
content-blind by design. File contents are encrypted in the browser before
upload, so the instance pins ciphertext to IPFS and never holds the key.
Against a **passive** operator — one who reads the database, or whose backups
leak, or who is compelled to hand over what they have — this works.

Against an **active** operator it is weaker, and the honest version is worth
reading twice. The instance can mint a Matrix device for any of its users at
any time (T17). Room keys are shared only with devices carrying a
cross-signature, so a minted device receives nothing until a real device signs
it — but *whether it gets signed is a decision a person makes in a dialog*. The
cryptography can refuse to send keys to an unverified device. It cannot stop
someone clicking through.

Better than plaintext by a wide margin. Not the same as Signal.

**Metadata is not encrypted anywhere**, and with encryption on everywhere it is
now the whole of what an operator can read: who is in which channel, who spoke,
when, how often, filenames, file sizes, and who reacted to what. That is a lot
about a conversation without a word of it.

**A client that cannot hold keys reads nothing**, rather than falling back to
something readable. On a capable instance that includes the instance's own API:
it cannot compose Megolm, so it refuses to send or edit rather than writing
plaintext into a room whose members believe otherwise. Encryption everywhere
means the API can no longer speak in any channel, which is the point and is
also a real constraint on bots and integrations.

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

**Capabilities:** Full database and homeserver access. Can read every plaintext
message, impersonate any member, and alter history. Can read metadata
everywhere, encrypted channels included: who is in which channel, who spoke,
when, how often, filenames, file sizes, and who reacted to what.

**Affected:** Everything on that instance except the *contents* of encrypted
channels and the files shared in them.

**Mitigations:** For a plaintext channel — one created before encryption became
the default, or any channel on an instance that can't offer it — none
technical. The interface states plainly that messages are readable by whoever
runs the instance, so the choice is informed. Per-server identity limits blast
radius to that one community.

For an encrypted channel, which is now every channel a capable instance
creates, Megolm (ADR 0008 stage 4, ADR 0011). Keys live on members' devices;
the instance stores ciphertext and its index records those messages
content-blind, so there is no readable copy for it to hold. File contents are
AES-encrypted in the browser before upload, with the key carried in the
Megolm-encrypted event, so the instance pins ciphertext it cannot open.

This covers contents only. The metadata above is unchanged, and an operator
still knows exactly who is talking to whom, how often, and what their files are
called.

**Residual risk: total in a plaintext channel, and metadata everywhere.**
Choosing whose instance you join *is* the security decision. In an encrypted
channel it drops to what an active operator can reach through T17 and T20,
which is not nothing.

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

**Mitigations:** Sessions are **device-scoped and named**: the instance's own
session is a fixed, recognisable device, and every session is listable and
individually revocable from account settings. Desktop credentials live in the
OS keychain, not browser storage.

"Tokens are held server-side and never sent to browsers" **stopped being true
with ADR 0008 stage 3.** On instances that advertise `clientMatrix`, a client
obtains its own device-scoped token over the authenticated instance API and
syncs directly. The browser keeps that token in memory only — the persisted
part is the device id, which is useless without a fresh login through the
instance. Revoking the device from account settings kills the stream at the
next request; the client treats a 401 as final rather than retrying. On
instances without the capability, the proxy remains and tokens still never
leave the server.

**Residual risk: moderate.** A token exfiltrated from a running tab acts as
that device until revoked. That is a narrower credential than before — one
device, visible in the device list, individually revocable — where the
previous design had one invisible token nothing could revoke. See T17: the
instance can still create a new session at any time, so revoking one does not
lock the instance out.

---

### T17 — The instance can log in as any of its users

**Capabilities:** Create a Matrix session for any account, silently, at any
time, without the user's involvement.

**Affected:** Every account on the instance.

**Why:** Matrix passwords are derived — `HMAC(app secret, "matrix-account:<id>")`
— so a lost access token can always be recovered by logging in again, and no
plaintext password is stored anywhere. Both are genuine benefits. The cost is
that whatever can compute the HMAC can authenticate as anyone.

**Mitigations:** The app secret is loopback-scoped and never leaves the server
process, so this is not reachable from outside — it is a capability the
*instance* has, not one an external attacker gains.

For encrypted channels, `globalBlacklistUnverifiedDevices = true` paired with
`setTrustCrossSignedDevices(true)` in the client, neither configurable. A
minted device receives no room keys at all until a device belonging to that
user cross-signs it. That is stronger than the SDK default, under which the
minted device receives keys like any other and a warning is the only
protection. The client
lists every device with its verification state, puts unverified ones at the
top, and says in as many words that an unrecognised device may have been
created by whoever runs the instance.

**Residual risk: subsumed by T1 in a plaintext channel; the sharpest remaining
edge in an encrypted one.** Where messages are plaintext this adds nothing —
the operator can already read everything. In an encrypted channel it is the
difference between a passive and an active adversary, and the defence now
terminates in a person: the cryptography will refuse to send keys to an
unverified device, and nothing stops someone verifying one they shouldn't.

Stated plainly, so the E2EE claim is accurate: against a **passive** operator,
encryption works. Against an **active** one who mints a device and waits, it
reduces to "you were shown a warning and had to act on it". A real improvement.
Not the same as Signal.

The fix is to remove the derived password, which requires solving Matrix
account recovery without it. That is its own decision and has not been made.

See [ADR 0008](adr/0008-client-side-matrix.md) and
[ADR 0011](adr/0011-crypto-machine.md).

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

### T18 — Community rooms open at the Matrix layer

**Capabilities:** Join any community without an invite, enumerate every
community on the instance, and — once clients sync directly — invite arbitrary
Matrix users into a community, including someone the instance has banned.

**Affected:** Any instance whose homeserver is reachable.

**Why it existed:** Rooms were created with `preset: "public_chat"` and
`visibility: "public"`. That means `join_rule: public`, listing in the
homeserver's public room directory, and an invite power level of 0. SOVRGN's
own join policy defaults to invite-only, so the application was enforcing a
rule the layer beneath it contradicted.

It was unreachable in practice only because the homeserver was loopback-only.
ADR 0008 stage 2 makes exposing the homeserver a supported configuration, which
turned a latent contradiction into a live one.

**Mitigations:** Spaces are now `private_chat` and unlisted; channel rooms use
a restricted join rule keyed on Space membership, so joining a community still
gets you its channels without the rooms being open. Inviting requires the
moderator power level. The room version is pinned, because an older default
would silently produce a public room again.

**Residual risk: moderate, for existing instances.** These are creation-time
settings. Communities created before this change keep their old join rules, and
repairing them means rewriting room state on a live homeserver — see
docs/UPGRADING.md.

---

### T19 — Forged appservice transactions

**Capabilities:** Write arbitrary rows into the message index: fabricate
messages attributed to any member, apply edits and redactions that were never
sent, seed the index with content nobody authored.

**Affected:** Instances with the appservice ingest configured (ADR 0009).
Unconfigured instances do not expose the endpoint at all — it 404s.

**Why it exists:** The ingest is how the database learns about events the
instance did not compose. An endpoint that accepts event pushes is, by
construction, a message-writing API, so its authentication carries the same
weight as the session cookie's.

**Mitigations:** Every transaction must present the `hs_token` from the
registration file; comparison is constant-time, failures are logged and 403.
The token is generated by the operator (`openssl rand -hex 32`), lives in the
environment and the registration file, and appears in no client, no log line,
and no descriptor. In the stock compose deployment the endpoint is only
reachable from the internal network. Ingest is idempotent by event id, so a
replayed transaction changes nothing.

**Residual risk: low.** A leaked `hs_token` allows index forgery until
rotated — but not message *reading*, and not Matrix-side forgery, because the
homeserver doesn't accept the hs_token for anything. Rotation is editing two
files and restarting both services.

---

### T20 — The instance's cooperation in cross-signing setup

**Capabilities:** During the moment a user sets up encryption, substitute the
instance's own cross-signing keys for the ones the user's client generated —
becoming, from that point, an identity other users' clients may trust.

**Affected:** Any account setting up or resetting cross-signing.

**Why it exists:** Uploading cross-signing keys is user-interactive-auth gated,
and this instance's Matrix passwords are derived (T17), so the instance knows
them and the browser does not. The alternative was to hand the derived password
to the browser for the duration of the flow, which would put a permanent,
unrotatable, fully-authorising credential inside a web page and within reach of
any XSS. Instead the client starts the flow, receives a UIA session id, and
asks the instance to satisfy that one stage. See [ADR 0011](adr/0011-crypto-machine.md).

**Mitigations:** The private cross-signing keys never leave the browser and the
password never enters it — only a session id the homeserver issued moments
earlier crosses, and it is meaningless without the request the client is
already making. The instance's own request carries an auth dict and no keys.
The password used is derived from the authenticated caller's user id, so
presenting somebody else's session id completes a stage the homeserver will
then reject.

Crucially, substitution is **not silent**: a master key change is published to
every device of every user who has verified that account, and clients report it
as exactly the identity change verification exists to surface.

**Residual risk: real, visible, and the same shape as T17.** This is a second
route to the same place, and it has the same resolution — removing the derived
password. Until then it is disclosed rather than mitigated.

---

### T21 — Crypto store readable in the browser profile

**Capabilities:** Read a user's Megolm inbound sessions, and therefore the
plaintext of encrypted messages that device has received, from the browser's
IndexedDB.

**Affected:** Anyone with access to the browser profile on disk — malware
running as the user, another process with filesystem access, someone at an
unlocked machine, a synced or backed-up profile.

**Why it exists:** The crypto store has to persist. Megolm inbound sessions are
the only copy of the ability to read messages already received, so a store that
reset on refresh would make every page reload permanent history loss.

**Mitigations:** None cryptographic, deliberately. The store can be encrypted
with a `storageKey`, but the browser has no keychain to hold one — the key
would have to sit somewhere the same attacker can already read, or come from a
passphrase prompt on every page load, which is a feature nobody keeps enabled.
Obfuscation described as encryption is worse than a documented gap.

What *is* mitigated: the Matrix access token is still never persisted. It lives
in memory for the tab's lifetime and is re-minted over the authenticated
instance API on reload (ADR 0008 stage 3), so a stolen profile yields past
message keys but not a live session. Recovery keys and secret storage keys are
memory-only for the same reason.

**Residual risk: moderate, and inherent to a browser client.** The desktop
shell has an OS keychain available and does not yet use it; that is the obvious
improvement and has not been made.

---

## What an attacker cannot do

- Read messages on an instance they have no access to
- Use an identity token minted for one instance against another
- Sign up on a homeserver directly — public registration is disabled
- Reach Postgres, the homeserver admin API, or the IPFS admin API from outside
- Take over an account by claiming an unverified email
- Escalate to a role at or above the person acting

## Known gaps

1. **Metadata is readable in every channel**, encrypted ones included:
   membership, timing, who spoke, filenames, file sizes, reactions. Channels
   created before encryption became the default are plaintext, as are all
   channels on an instance whose homeserver clients cannot reach.
2. **The instance can log in as any user** (T17), and its cooperation is
   required to set up cross-signing (T20). Both trace to the derived password,
   and both are now the sharpest edge rather than a future one.
3. **Communities created before v0.4.2 have public Matrix join rules** (T18).
   Creation-time settings; repairing them means rewriting live room state.
4. **No session revocation.** Stateless one-year JWTs; logout doesn't invalidate.
5. **No 2FA for local accounts.**
6. **Backups are unencrypted at rest.**
7. **No `jti` replay tracking** within a token's lifetime.
8. **No rate limiting on most API surface** beyond login.
9. **No audit log** of administrative actions.
10. **The browser's crypto store is unencrypted at rest** (T21). The desktop
    shell has an OS keychain and does not yet use it.
11. **No independent security audit.** Careful review is not an audit, and the
    cryptography arriving in this release raises what an audit would be worth.

## Related

Mechanism-level detail — token formats, lifetimes, key caching behaviour — is
in [SECURITY_ARCHITECTURE.md](SECURITY_ARCHITECTURE.md).

## Reporting

Email `security@formicaria.us` rather than opening a public issue.
