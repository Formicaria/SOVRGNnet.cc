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

## Decision 3 — verification is inherited, and keys are not withheld

`setTrustCrossSignedDevices(true)`, so a device its owner has cross-signed
counts as verified and a person verifies *people* rather than devices.
`globalBlacklistUnverifiedDevices` stays **false**.

**This reverses an earlier decision in this same ADR, and the reversal is the
useful part.**

The flag was set true, reasoning that an operator-minted device should receive
no room keys at all rather than merely be flagged — turning ADR 0008's "you
would have been warned" into "that device received nothing". That reasoning was
correct about what the setting buys and wrong about what it costs.

The e2e crypto stage found the cost the first time it ran. On a fresh instance
nobody has cross-signed anything, so every device is unverified, so every room
key is withheld from everyone, and no encrypted message is readable by anybody:

```
Created batch of to-device messages of type m.room_key.withheld
Failed to decrypt: withheld code: Some("m.unverified")
```

Encryption on by default (decision above) plus keys withheld from unverified
devices is a product that does not work at all.

Cross-signing does not rescue it either. For Alice to treat Bob's device as
verified she must have verified *Bob*, so with the flag on every pair of people
in a community must compare emoji before they can exchange a message. That is a
reasonable arrangement for two journalists and an impossible one for a chat
server with thirty people in it.

So the position is the one ADR 0008 wrote down before any of this was built:
**against an active operator, encryption reduces to "you would have been
warned", and the warning is the device list.** That is weaker than withholding.
It is what a working group-chat product can offer. Shipping the stronger
setting and an unusable product, or shipping the stronger claim over the weaker
setting, would both have been worse.

What survives is worth having: cross-signed devices are trusted automatically
so verification is a per-person act that scales, unverified devices sort to the
top of the device list, and the client says plainly that an unrecognised device
may have been created by whoever runs the instance.

The lesson generalises, which is why it's recorded rather than quietly fixed: a
hardening setting that has never been run against a real two-device
conversation is a hypothesis, not a mitigation. This one was written into the
threat model as a mitigation before anything had executed it.

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

It also covers **cross-signing setup, emoji verification between two devices,
and recovery on a third from the recovery key alone** — the last being what ADR
0008 made a precondition for flipping `e2ee`, and what had never run. These were
once described here as needing an interactive exchange a script couldn't drive;
that was wrong. Interactive describes the dialog. Both sides of a verification
are ordinary API calls and the emoji comparison is a string comparison.

**A verification request to a device nobody knows about is silently dropped.**
Found by that check on its first run. The rust machine logs "Could not retrieve
the device data for the incoming verification request, ignoring it" and does
nothing else — no error, no cancellation, no phase change. So a device that
signs in and immediately asks to be verified can wait forever for an answer to
a question the other device discarded. The window is seconds wide and sits
exactly where verification matters most: a device that just appeared, which is
both the ordinary sign-in case and the operator-minted-device case. Mitigated
by publishing the device before requesting; not eliminated, because only the
other side's next sync closes it. A client that gets no response should let the
person retry rather than report a failure.

**A device that just signed in is not ready for anything that needs its own
identity.** Three separate failures with one shape, all found by the same
script and all invisible to a typecheck: a verification request from an unknown
device is discarded, `startVerification` throws before the reply names a
device, and importing cross-signing keys fails with no public identity to
import them against. Each is fixed by downloading the user's own device list
first. The pattern is worth stating on its own, because the next thing added to
this module will hit it too: **the crypto machine's view of an account is not
populated at sign-in, and any operation touching your own identity has to say
so before it acts.**

The third case matters most, because of what it *says*. The rust store logs "a
/keys/query needs to be done"; the SDK surfaces "importCrossSigningKeys failed
to import the keys"; a person reads "my recovery key is wrong" and goes looking
for another copy of a key that was correct all along.

**Key backup lags sending, by tens of seconds.** Uploading a room key to backup
is a background loop, not part of `send`, and the loop sleeps a *random* 0–10s
before each pass — deliberately, so that every client in a room doesn't hit the
server at once when a key rotates. A key created just after a pass begins waits
for the pass after that, so two jitters can stack.

So there is a window, longer than it sounds, in which a message has been
delivered and its key is not yet recoverable. A device signing in during it
restores nothing and shows the message as undecryptable. It resolves itself
when the sending device's next pass runs; the remedy is to wait and try again,
not to re-enter the recovery key — worth stating plainly, because "recovery
didn't work" is exactly when someone starts doubting the key they were given.

Also worth knowing for anyone writing a check against this: `getKeyBackupInfo()`
serves a *cached* answer once any check has run, so polling it to watch the
count climb returns the same stale number indefinitely.
`checkKeyBackupAndEnable()` forces a re-fetch.

**What actually decrypts the message on the recovered device is not the restore
call.** Worth recording, because the check reads as though it were. Handing
`recoverWithKey` the recovery key gives the device the backup decryption
secret, and the SDK's per-session downloader — which had been logging "no
decryption key" and giving up — immediately fetches the one session it needs
and retries the event. The bulk `restoreKeyBackup` that follows finds the key
already present and the rust store discards it as a duplicate
(`imported_count=0`), while the SDK still reports `1 of 1`, because its count
is *keys the backup returned*, not *keys newly added*.

Both paths hang off the same cause, so the check isn't lying about recovery
working. But its two halves measure different things, and only one of them is
what a person experiences: the assertion on `imported` proves the server gave
the key back, and the decryption that follows proves the device could use it.
Anyone tightening this check should not "fix" the zero — it is the correct
answer to a question the check isn't asking.

Still unproven: **the browser runtime**. Node exercises the same module, not the
same environment — IndexedDB, the Vite-bundled WASM and the React wiring are
untouched. `scripts/e2e-browser.spec.ts` covers those four claims and runs
outside preflight, because it needs a browser download and a stack left
standing.

Its first execution failed four times, and every one of those failures was in
the test. Worth recording as such: the Node stage found five defects in the
product, and the honest report of the browser stage's debut is that it found one
in itself. The spec registered a new account with the setup code, but the only
stack a browser can reach is one `--keep` left behind, and such a stack has
always already run the journey — its first account is claimed, its setup code
spent, and the sign-up form it offers asks for an *invite code*. The spec spent
fifteen seconds waiting for a field that instance can never render.

The other three failures were the first one's missing session surfacing later,
which is the more useful half. Sharing a signed-in browser context between tests
turned one defect into four reports of it and hid which was real. Each test now
reaches the dashboard on its own — necessary anyway, since one of them asserts
the access token is kept *out* of web storage, and a file that assumed the
context would remember a sign-in would be leaning on the thing it exists to
disprove.

## References

- [ADR 0008](0008-client-side-matrix.md) — the four stages
- [ADR 0009](0009-appservice-ingest.md) — why the index holds ciphertext
- [THREAT_MODEL.md](../THREAT_MODEL.md) — T1, T8, T20, T21
- [`shared/e2ee.ts`](../../shared/e2ee.ts) — the decisions, tested
- [`client/src/lib/matrixCrypto.ts`](../../client/src/lib/matrixCrypto.ts) — the machine
