# ADR 0015 — Encryption is not a feature

**Status:** Accepted · September 2026
**Builds on:** [ADR 0008](0008-client-side-matrix.md) (client-side sessions),
[ADR 0009](0009-appservice-ingest.md) (Matrix as source of record),
[ADR 0011](0011-crypto-machine.md) (the crypto machine)
**Supersedes:** ADR 0009's "operators must wire a registration file" — the
opt-in stance on the appservice — and the per-channel encryption switch.

## Context

By ADR 0008 stage 4 the whole of end-to-end encryption existed: Olm and
Megolm in the client, a send path for encrypted channels that refuses to fall
back to plaintext, encrypted attachments, daily key rotation, device
verification, recovery keys. The instance derives its `e2ee` capability
honestly from three facts — the code ships it, a homeserver answers at an
address clients can reach, and the appservice records what clients author —
and refuses to claim encryption any of them makes false. That derivation was
right and remains right.

What the honesty revealed, on the first desktop host whose descriptor anyone
read, is that the three facts are false on every stock deployment:

```
"e2ee": false, "clientMatrix": false, "eventIngest": false, "matrixBaseUrl": null
```

Not because anything was switched off. Because two of the three conditions
were left for an operator to establish by hand — `MATRIX_PUBLIC_URL` pointing
at a homeserver they had exposed, a registration file they had rendered and
listed in `dendrite.yaml` — and a desktop host has no operator. The e2e
harness wires both, which is how encryption is tested; `install.sh` wires
neither, which is how it ships. And a channel that clears all three hurdles
is *still* plaintext until an administrator finds the irreversible switch.

So encryption was implemented, tested, honest about itself, and off. The
project's stated reason to exist — messages on hardware the participants own,
readable by nobody else — was true only for people who had read
`docs/UPGRADING.md` §appservice and acted on it, and the interface said "not
end-to-end encrypted" beside every conversation as if that were a property
of the room rather than a gap in the install.

## Decision

**End-to-end encryption is the only mode.** It is not a capability an
instance may or may not offer, a channel setting, or a thing an operator
opts into. Every deployment path establishes the conditions; every room is
encrypted from the moment it exists; the client has no path that sends
plaintext into a room.

Concretely, and in the order the conditions have to be made true:

1. **The instance proxies its homeserver.** The app serves `/_matrix/client`,
   `/_matrix/media` and `/_matrix/key` by streaming them to Dendrite on
   loopback, and `/.well-known/matrix/client` delegates to the origin the
   request arrived on. One address — the tunnel, the LAN, or loopback —
   serves the app and the homeserver, so `clientMatrix` is true wherever the
   app is reachable and there is nothing for an operator to expose.
   `/_matrix/app` is excluded: that is the appservice's *inbound*, hs-token
   gated, and must not be reachable from a client.

2. **The appservice is registered by whatever installs the instance.** The
   desktop supervisor generates the two tokens like every other host secret,
   renders the registration file, lists it in the rendered `dendrite.yaml`
   and passes the tokens to the app. `install.sh` does the same for Docker.
   The Dendrite template gains its `app_service_api` section; it no longer
   "deliberately ships without" one.

3. **Rooms are encrypted at creation.** Both room-creating paths —
   a channel, and a community's `#general` — write `m.room.encryption` into
   `initial_state`. There is no plaintext room to switch on later.

4. **Existing channels are encrypted once, at the first start that can.**
   A one-shot sweep, run when the instance boots with e2ee available, enables
   encryption on every channel that predates this decision. It runs once per
   channel, is idempotent, and is the same call the admin switch made.

5. **The client's plaintext send path is removed**, not left unused. The
   fallback that composed a message server-side when a client could not
   author its own was the right safety net while plaintext was a possible
   state of a room. It is now a way to put cleartext into an encrypted room
   and nothing else. A client without a crypto session cannot send, and says
   so in words. `messages.send` refuses any channel that is encrypted, which
   is every channel.

6. **The recovery key is part of setting up an account.** Not a panel a
   person may find. The first sign-in on a fresh client offers the key
   before anything else, keeps offering until it is saved or explicitly
   declined, and the desktop's first-account flow does the same — because
   the consequence below is real and the key is the only mitigation.

## Consequences

**Lose every device and the recovery key, and the history is gone.** The
server holds ciphertext it cannot read and keys it never had; there is no
reset, no support path, no administrator who can help. This is the property
being bought, stated as the cost it is. Every person is told at setup,
in those words, and given the key.

**Plaintext already written stays plaintext.** Messages sent before the sweep
are on disk in the clear and encrypting them now would protect nothing.
Rooms that predate this decision carry both: old rows readable by the
instance, new events not. The interface marks the boundary rather than
pretending the old rows are protected.

**Server-side authoring ends.** Nothing that composed messages through the
API — there was one such path, the fallback — can do so. Anything that wants
to write into a room is a Matrix client with keys, or it is not writing.

**The instance's `e2ee` derivation is unchanged and now expected true.** It
still refuses to claim what the deployment cannot do, which is the right
property to keep. What changes is that a false answer is a fault: the host
panel shows it as a failed condition with the reason, the walk
(`docs/VERIFY_DESKTOP.md` step 5) inverts its expectation, and the "not
end-to-end encrypted" pill means "something is wrong with this server", not
"this is how this server is".

**The proxy is a new surface the app serves.** Every Matrix client-server
request now passes through the app process. Streamed, not buffered — media
uploads are large and `/sync` long-polls — and mounted before body parsing so
`express.json` never sees a 50MB upload it would otherwise buffer. It is also
the one place a request for the homeserver can be denied; `/_matrix/app` is
denied there.

**A homeserver that cannot be proxied is a server that cannot be used
encrypted**, and the panel says so. Previously that was a server that quietly
worked in plaintext. The regression is deliberate.

## Alternatives considered

**Encrypted by default, with a way to turn it off.** A per-instance switch,
on unless an operator flips it. Rejected: it keeps the plaintext send path
alive, and a path that exists is a path something will take. The project's
history is the argument — the API fallback was written as a safety net and
became the state every deployment lived in. The option is the exposure.

**Keep the opt-in, fix the desktop only.** Wire the supervisor and leave
`install.sh` as documented follow-up. Rejected because it was already
documented follow-up, in 0009, for a release and a half. The desktop is the
path with no operator; Docker is the path whose operator was told the step
was optional and recommended. Neither reading produced an encrypted instance.

**A second tunnel for the homeserver.** Expose Dendrite on its own public
address rather than proxy it. Rejected: a quick tunnel is one origin, so this
means two tunnels with two changing hostnames, one of which must be written
into the other's delegation document every restart. The proxy makes the
homeserver's address the app's address, which is the address every client
already has.

**Encrypt old messages at the sweep.** Rejected as false safety: the rows
have been on disk in the clear for their whole life, and re-writing them as
ciphertext would protect them from an attacker who arrives after the sweep
and nobody else, while making them unreadable to any member who joined after
the key rotated. Honest boundary, not retroactive lock icon.

## References

- ADR 0009 §Consequences, the two follow-ups this record completes.
- `shared/e2ee.ts` `deriveE2eeCapability` — the derivation, unchanged.
- `scripts/e2e.sh` "Appservice ingest" — the recipe that always worked.
- `server/matrixProxy.ts` — the proxy.
- `server/encryptionSweep.ts` — the one-shot.
