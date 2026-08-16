# ADR 0008 — The client owns the Matrix session

**Status:** Accepted · August 2026 · stages 1–3 implemented; 4 outstanding
**Reverses:** the proxy decision in [ADR 0001](0001-multi-server-client.md) and
[ARCHITECTURE.md](../ARCHITECTURE.md)

## Context

Today the instance holds each user's Matrix access token server-side and acts
on their behalf. The browser never touches Matrix. That was the right call and
it is documented as a security property: threat T8 lists "tokens are held
server-side and never sent to browsers" as a mitigation.

It also makes end-to-end encryption impossible. Not difficult — impossible.
E2EE means the keys live on devices and the server holds ciphertext it cannot
read. A server that composes every event on the user's behalf necessarily holds
the plaintext. There is no version of the current architecture that also has
E2EE; the two are mutually exclusive by construction.

Since E2EE is the largest open gap in the threat model and the one thing that
would move the instance operator from "inside your trust boundary" to "cannot
read your messages", the proxy has to go.

Three other things fall out of the current design and are worth naming, because
they change the shape of the fix:

**Live updates are a 3-second poll.** Four separate intervals in the dashboard,
each re-fetching through tRPC. A client with its own Matrix session gets
`/sync` instead — a long-poll the homeserver already implements well.

**Nothing tracks devices.** `login()` sends no `device_id` and no display name,
so every login silently creates a new anonymous device on the homeserver. This
is why T8's residual risk says there is no per-device revocation: there is
nothing to revoke, because nothing is identified.

**The instance can log in as anyone, at any time.** This is the important one.

## The derived-password problem

`deriveMatrixPassword(userId)` is an HMAC of the user's id keyed with the app's
own secret:

```ts
createHmac("sha256", ENV.cookieSecret).update(`matrix-account:${userId}`)
```

Deterministic, so a lost access token can always be recovered by logging in
again, and no plaintext password is stored anywhere. Both are real benefits and
neither is why it matters here.

It matters because **the instance can mint a new Matrix device for any user
whenever it likes**, without the user's involvement, and without anything
appearing to go wrong.

Under E2EE, that is not a footnote. Matrix already defends against exactly this
with device verification: a new device is untrusted until an existing device
signs it, and clients warn about unverified devices in a room. But the defence
only works if people act on the warning. An instance operator who adds a device
and waits will receive newly-sent room keys from any client configured to share
with unverified devices.

So the honest statement of what E2EE will and will not buy on this
architecture:

- **Against a passive operator** — one who reads the database, or whose backups
  leak, or who is compelled to hand over what they have — E2EE works. The
  message content is ciphertext they do not have keys for.
- **Against an active operator** — one who mints a device and waits for keys —
  E2EE reduces to "you would have been warned". That is meaningfully better
  than today, and it is not the same as Signal.

Removing the derived password entirely means the instance can no longer recover
a user's Matrix account, which breaks account provisioning as it currently
works. That trade is a separate decision and is deliberately not being made
here; see *Consequences*.

What this ADR does commit to is **not claiming otherwise**. The `e2ee`
capability will describe what it actually delivers, and the threat model will
carry this as its own entry rather than burying it in T1.

## Decision

**The client obtains its own device-scoped Matrix session and syncs directly.**

Four stages, each shippable and each leaving the product working:

**1 — Device-scoped sessions.** `login()` starts sending `device_id` and
`initial_device_display_name`. The instance keeps its own session under a
recognisable device ("SOVRGNnet server"), and each client gets a separate one.
Devices become listable and revocable. Nothing else changes yet, and T8's gap
closes on its own.

**2 — The homeserver becomes reachable.** ✅ The app serves
`/.well-known/matrix/client` and `/.well-known/matrix/server`, so delegation
works in every deployment shape rather than only where nginx was configured by
hand. Server delegation is gated on federation actually being enabled, because
advertising an endpoint the instance then refuses is worse than advertising
none.

`clientMatrix` is now derived from a cached probe of
`/_matrix/client/versions` at the advertised address — it takes a homeserver
answering, not an environment variable being set. It was `Boolean(
MATRIX_PUBLIC_URL)`, which is the same mistake `encryption` made in v0.3: a
deployment detail silently becoming a claim. The probe distinguishes "something
answered" from "a homeserver answered", because a reverse proxy's own 200 page
passes a naive check and fails every real request afterwards.

Opt-in per instance: an operator who sets nothing keeps the proxy, and nothing
about their deployment changes.

**3 — Direct sync.** ✅ The client obtains a device-scoped session over the
authenticated instance API (`matrix.clientSession`, gated on the same probe
that decides `clientMatrix`) and long-polls `/sync` itself — a hand-rolled
engine of ~150 lines rather than matrix-js-sdk, which earns its megabyte when
stage 4 needs its crypto. Message and file liveness ride the stream: the two
heavy polls (messages 3s, files 5s) switch off when sync is live, and uploads
now emit an `m.file` room event so files announce themselves. The typing and
member-list polls remain — they carry instance-level data (tRPC-recorded
typing, roles, presence) that never lived in Matrix rooms, and moving them is
a product decision this stage doesn't smuggle in. Sending also stays on the
instance API, where permission enforcement already lives. The proxy remains
for instances that have not completed stage 2, selected by capability.

**4 — Olm/Megolm.** Encryption, cross-signing, device verification, and key
backup. `e2ee` flips only when all of it works, including recovery.

*In progress.* The transport and index groundwork is done: sync delivers the
crypto signal set (to-device messages — including from the initial batch,
where queued room keys live — device-list changes, one-time-key counts), the
appservice records `m.room.encryption` state so the index knows which rooms
are encrypted, encrypted events are stored content-blind, clients render them
as explicitly unreadable, and both send paths refuse plaintext into encrypted
rooms rather than quietly undermining them. What remains is the crypto machine
itself: Olm/Megolm sessions, verification, backup, recovery. `e2ee` stays
false until all of it — including recovery — works.

Stages 1 and 2 are worth having on their own merits even if 3 and 4 slipped.
That is the test for whether a staged plan is real.

## Consequences

**A stated security property goes away.** "Matrix tokens never reach the
browser" stops being true the moment stage 3 lands. The threat model must be
edited when the code changes, not before and not after. The replacement
mitigation — device-scoped tokens that can be individually revoked — is
strictly better than the current one, which is "there is one token and nothing
can revoke it", but it is a different property and must be described as one.

**Permission enforcement moves.** Today every write is checked server-side
because every write goes through the server. With direct sync, Matrix's own
power levels become load-bearing. They are already kept in sync
(`syncPowerLevels`), which is why this is a change of emphasis rather than of
mechanism — but any check that exists only in `routers.ts` and not in the room
state becomes advisory, and each one needs auditing before stage 3.

**Instances that don't complete stage 2 keep working.** A homeserver on
loopback is a legitimate deployment — it is what the LXC install produces by
default — and those instances stay on the proxy indefinitely. This is what
capability negotiation is for, and it is the first real use of it beyond
description.

**The derived password stays for now, and is disclosed.** Removing it means
solving Matrix account recovery without it, which is its own design. Until
then, the ADR's position is that an architecture whose limits are written down
is worth more than one whose limits are discovered.

## Alternatives considered

**Keep the proxy and encrypt in the server.** Rejected: a server that holds the
keys is not end-to-end encryption, and shipping it under that name would be the
exact dishonesty this project keeps auditing itself for.

**Client-side Matrix for desktop only, proxy for web.** Tempting, since the
desktop has an OS keychain and the browser has localStorage. Rejected as the
*architecture*, accepted as the *outcome*: capability negotiation already
allows an instance to expose direct sync while a browser client declines to use
it. Encoding it as a platform rule would put the decision in the wrong place.

**Do stages 3 and 4 together.** Rejected. Moving the transport and introducing
cryptography in one change means any failure has two candidate causes, and key
management is where this gets genuinely hard. Separating them keeps each
reviewable.

**Drop the derived password now, as part of stage 1.** Rejected as scope. It
is a real fix for a real weakness, and doing it inside a change about device
identity would couple two independent decisions. It gets its own ADR.

## References

- [`server/matrixService.ts`](../../server/matrixService.ts) — the proxy
- [THREAT_MODEL.md](../THREAT_MODEL.md) — T1, T8
- [ADR 0001](0001-multi-server-client.md) — where the proxy was chosen
- [ADR 0007](0007-protocol-versioning.md) — the capability negotiation this depends on
