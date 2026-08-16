# ADR 0011 — The crypto machine

**Status:** Accepted · August 2026 · implemented
**Completes:** [ADR 0008](0008-client-side-matrix.md) stage 4
**Depends on:** [ADR 0009](0009-appservice-ingest.md) (the database as an index)

## Context

ADR 0008 planned four stages and shipped three. Stage 4 was one line —
"Olm/Megolm. Encryption, cross-signing, device verification, and key backup.
`e2ee` flips only when all of it works, including recovery" — which is the
correct amount of detail for a plan and nowhere near enough to implement.

Building it surfaced four decisions ADR 0008 didn't anticipate, three of them
uncomfortable. This records them.

## Decision 1 — matrix-js-sdk owns the client's Matrix session

ADR 0008 stage 3 shipped a hand-rolled `/sync` engine of ~150 lines and said
the SDK "waits for stage 4, where its crypto earns the bundle weight". It has.

Olm and Megolm are not code this project should write. The interesting risk in
a chat application is whether a room key reaches the right devices and no
others, not whether an AES round is correct; every hour spent on the second is
an hour not spent on the first, and the second is where a mistake is
unrecoverable and silent.

Having adopted the SDK, **the hand-rolled engine is deleted rather than kept**.
Two sync engines against one homeserver means two positions in the same stream,
two answers to "has this event arrived", and a bug with two candidate causes —
which is the exact reason ADR 0008 refused to do stages 3 and 4 together.
Keeping both afterwards would have made that permanent instead of temporary.
`shared/matrixSyncCore.ts` and its test suite are gone.

The cost is bundle weight, and it is not small: roughly 1 MB of JavaScript and
a 7.8 MB WASM module, which is larger than everything else the client ships
combined. It is paid only by instances that can use it. The entire crypto
module sits behind a dynamic import gated on the `clientMatrix` capability and
none of it reaches the entry chunk, so an instance whose homeserver is on
loopback fetches none of it and behaves exactly as it did in v0.5.

## Decision 2 — cross-signing setup goes through the instance

The uncomfortable one.

Uploading cross-signing keys is user-interactive-auth gated: the homeserver
wants the account password before it accepts a new identity for the account.
This instance's Matrix passwords are derived — `deriveMatrixPassword(userId)`
is an HMAC of the user id keyed with the app secret — so **the instance knows
every password and the browser knows none**. ADR 0008 named this as the
architecture's central weakness and deliberately deferred fixing it. Stage 4
has to work in the meantime.

The obvious version is to have the instance hand the derived password to the
client for the duration of the flow. Rejected: that password is permanent,
unrotatable, authorises everything, and cannot be revoked without changing the
app secret for every user at once. Putting it in a web page puts it within
reach of any XSS this application ever has.

Instead the browser completes the flow *without* it. UIA stages are completed
against a session id, not against a request body — which is why the SSO stage
can be satisfied in a different window entirely. So:

1. The client calls `/keys/device_signing/upload` with no auth and gets a 401
   carrying a session id.
2. It asks the instance, over its authenticated API, to satisfy the password
   stage for that session. The instance POSTs the auth dict — and no keys.
3. The client re-submits its own request carrying only the session id. The flow
   is satisfied, and the homeserver processes keys the client generated and
   still holds privately.

The private cross-signing keys never leave the browser and the password never
enters it.

**What this does not fix.** In step 2 the instance holds a completed UIA
session for device-signing upload, and could upload cross-signing keys of its
own instead of leaving the stage for the client. It cannot do so invisibly: a
master key change is published to every device of every user who has verified
that account, and is precisely what the verification warnings exist to report.
This is the same residual risk ADR 0008 named for device minting, arriving by a
different route, and it has the same resolution — removing the derived
password, which remains its own decision and is not made here.

One detail worth keeping. A UIA stage is recorded as soon as the credentials
check out, *before* the endpoint examines the rest of the body. So the
instance's keyless request can complete the stage and then be rejected for
having nothing to upload. That rejection is success. Only 401 and 403 mean the
password was refused, and only those are treated as failure.

**This is an assumption about a homeserver, so it is checked against one — and
on Dendrite the check does not fire.** `scripts/e2e-journey.ts` runs the exact
sequence against the real homeserver: unauthenticated upload, assert a 401 with
a password stage, have the instance satisfy it, re-submit with the session id
and a freshly generated Ed25519 master key, read the key back from
`/keys/query`. A 401 on the re-submission fails the run loudly and says the
decision does not hold there.

Dendrite answers the first request `400`, not `401`. It does not gate
`/keys/device_signing/upload` behind interactive auth at all, so the client's
first attempt simply succeeds and none of the machinery above runs. Which
means:

- **On Dendrite this decision costs nothing and does nothing.** Cross-signing
  setup works, and the UIA path is dead code that never executes.
- **The path exists for Synapse**, which does gate the endpoint, and for any
  homeserver that later starts to. The client reaches for the instance only on
  a 401, so nothing has to be configured either way.
- **It is therefore unexercised rather than verified.** The harness says so in
  its output instead of printing a tick, because a green run that proved
  nothing is worse than a run that admits it. Verifying it needs a Synapse in
  the harness, which is a larger change than this one and has not been made.

No Olm is needed for the probe either way: a master cross-signing key is a
public key and carries no signature of its own.

## Decision 3 — keys are shared only with cross-signed devices

`globalBlacklistUnverifiedDevices = true` and `setTrustCrossSignedDevices(true)`
together, and neither configurable.

The pairing is worth stating because setting the wrong one of the two produces
something that looks correct and isn't. `globalBlacklistUnverifiedDevices` is
what withholds keys, and it defaults to false.
`setTrustCrossSignedDevices` decides what counts as verified — with it on, a
device its owner cross-signed qualifies, so a person verifies their own devices
once instead of verifying every device of everyone they talk to. Setting only
the second changes an icon and ships the keys regardless.

ADR 0008 drew the line between a passive operator ("E2EE works") and an active
one ("E2EE reduces to *you would have been warned*"), and observed that the
defence "only works if people act on the warning". With the permissive default,
an operator-minted device receives room keys from any client still configured
to share with unverified devices, and the warning is the *only* protection.
Requiring a cross-signature means the minted device gets nothing at all until a
real device belonging to that user signs it — an action a person must take and
can refuse.

The cost is not hidden: an unverified device of your own reads nothing until
you verify it, and someone who never verifies anything sees holes in encrypted
channels. The client says so, in those words, rather than showing a blank row.

## Decision 4 — for an encrypted room, the index is not the source of content

ADR 0009 made the database an index built from Matrix rather than a ledger
written beside it, and stage 4's groundwork made it store `m.room.encrypted`
content-blind. Both were right. Together they mean the index can order an
encrypted conversation, name its senders and timestamp it, while being
structurally incapable of rendering a word of it.

That is not a gap to close. An index that could render it would be an index the
operator can read, which is the arrangement this whole stage exists to end.

So the client joins two sources: the index supplies the message list, and the
crypto machine supplies plaintext, matched on the Matrix event id the index
does keep. Where the machine has no plaintext, **the row still appears and says
why**. A conversation with a visible hole in it is honest; one that silently
skips a message is not, and the difference matters most exactly when something
is wrong.

Opening an encrypted channel paginates that room's own timeline, because the
index knows an encrypted message exists but only the timeline carries the
ciphertext to decrypt.

## Consequences

**Sending into an encrypted room has no fallback, and that inverts a rule.**
Everywhere else a failed client-side send falls back to the instance API, on
the principle that a message must not be lost to an architectural preference.
Here the API path composes plaintext server-side, so falling back would put
cleartext into a room whose members believe it is encrypted. The send fails and
says so, and the text stays in the box.

**Crypto state persists on disk; the access token still does not.** Stage 3
kept the token in memory on purpose and that has not changed. But Megolm
inbound sessions are the only copy of the ability to read messages already
received, so they live in IndexedDB — a crypto store that reset on refresh
would make every reload permanent history loss. The store is not encrypted at
rest: the browser has no keychain, so the only places to keep a store
passphrase are somewhere the same attacker can read, or the user's head via a
prompt on every page load. This is disclosed as T21 rather than solved with
obfuscation.

**Encryption is the default, not a choice.** Every channel created on a capable
instance is encrypted; there is no toggle, because a lock that has to be found
is a lock most conversations never get. Existing plaintext channels keep an
admin-gated switch, since encrypting one cannot make its old messages ciphertext
and the action is irreversible — Matrix has no way to un-encrypt a room, so
neither does this.

The cost, stated where it can't be missed: **the instance's own API can no
longer write to any channel on a capable instance.** It holds no keys, so it
refuses rather than sending plaintext. Composing happens in a client with its
own session or it doesn't happen, and anything that posted through the API —
bots, integrations, scripts — stops working there.

**Attachments are encrypted client-side, or the default would be a lie.** With
every channel encrypted, a file upload that put readable bytes on the
instance's IPFS node would be a hole in every channel at once, under a lock
icon. So bytes are AES-CTR encrypted in the browser before upload with the key
inside the Megolm event, and the announcement moves from the server to the
client, since only a client can compose an event carrying that key. Filenames,
sizes and MIME types remain in the index in the clear — that is how the file
list works, and it is part of the metadata concession rather than an oversight.

**`e2ee` is derived, not declared.** Three things must hold: the build ships
crypto, a homeserver actually answered at the advertised address, and the
appservice is wired. An operator can set none of them with an environment
variable. The same codebase has twice turned a deployment detail into a claim —
`encryption` in v0.3 and `clientMatrix` before stage 2 — and a client acted on
the claim both times.

**The threat model changes again.** T1 no longer says the operator can read
message content on an encrypted channel, because on those channels it can't.
T20 and T21 are new: the operator's cooperation in cross-signing setup, and the
crypto store at rest in the browser profile.

## Alternatives considered

**`@matrix-org/matrix-sdk-crypto-wasm` alone, driving the existing sync
engine.** The Rust crypto machine is designed to be pumped by any sync loop, so
this would have kept the 150-line engine and added only cryptography. Rejected
on the same grounds as keeping two engines: the wiring between the machine and
the loop — outgoing request pumping, to-device dispatch, one-time key
replenishment, device list tracking — is precisely the part where an error
produces a room key sent to a device that shouldn't have it, and it would have
been ours to get right and ours to test. The SDK's version of that wiring is
exercised by every Element user.

**Hand the derived password to the client for the UIA flow.** See decision 2.

**Let anyone in a channel enable encryption.** Rejected. It cannot be undone by
anyone, including the person who did it, and it can lock members out.

**Ship Megolm now and defer verification, backup and recovery.** Tempting, and
it would have flipped `e2ee` two releases earlier. Rejected because ADR 0008
committed to the opposite in writing — "`e2ee` flips only when all of it works,
including recovery" — and a capability that means "encrypted, but a lost laptop
loses everything and an operator-minted device reads your messages" is the kind
of half-claim this project keeps auditing itself for.

## How this is verified

Three layers, and it is worth being precise about which one covers what,
because the interesting failures live in the gaps between them.

**Unit tests** cover the judgement, not the cryptography: what the instance may
claim, what a reader is told when a message won't open, what room state gets
written, that attachments round-trip and refuse tampering. None of it needs a
homeserver, and none of it proves a message was ever encrypted.

**The e2e journey** covers the instance's behaviour over HTTP: channels are
created encrypted without being asked, the API refuses to send or edit into
them, and it refuses for the right reason. It drives HTTP from Node and cannot
encrypt anything either.

**The crypto stage** (`scripts/e2e-crypto.ts`) closes that gap. It imports
`client/src/lib/matrixCrypto.ts` — the shipped module, not a reimplementation —
and runs it in Node with two device-scoped sessions against the harness's real
Dendrite. The only difference from the browser is `persistCryptoStore: false`,
because Node has no IndexedDB. It asserts that the crypto stack starts, that a
message becomes ciphertext, that **the index holds no plaintext anywhere**,
that a second device receives the room key and decrypts to the same string,
that stored file bytes are ciphertext, and that a tampered file is refused
rather than rendered.

Still unproven, and stated rather than implied: **SAS verification and key
backup**, both of which need an interactive exchange between two live sessions;
and **the browser path itself**, since Node exercises the same module but not
the same runtime. A browser-driven run would close the second.

## References

- [ADR 0008](0008-client-side-matrix.md) — the four stages
- [ADR 0009](0009-appservice-ingest.md) — why the index holds ciphertext
- [THREAT_MODEL.md](../THREAT_MODEL.md) — T1, T8, T20, T21
- [`shared/e2ee.ts`](../../shared/e2ee.ts) — the decisions, tested
- [`client/src/lib/matrixCrypto.ts`](../../client/src/lib/matrixCrypto.ts) — the machine
