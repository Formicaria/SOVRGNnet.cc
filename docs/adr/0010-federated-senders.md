# ADR 0010 — Federated senders in the index

**Status:** Accepted · August 2026 · index shape implemented; the two-instance
proof is the 0.7 completion criterion
**Builds on:** [ADR 0009](0009-appservice-ingest.md) (the database as an index
of Matrix)

## Context

0.7 promises federation "tested rather than merely possible". Before any test
can pass, a structural fact blocks it: **the message index cannot represent a
sender who isn't a local account.**

`messages.userId` is NOT NULL and joins to `users`. The appservice ingest
resolves `@sovrgn_7:this.instance` through `userProfiles` and skips anything
it can't attribute. Correct for a loopback instance — an unknown sender there
is noise — but under federation, an unknown sender is *the point*: a member
of the same room whose account lives on someone else's homeserver.

With today's shape, the first federated room would work perfectly at the
Matrix layer while this instance's index silently dropped every remote
message. Members on the polling fallback would see a conversation with holes
in it, and nothing would look broken.

## Decision

**Messages carry their Matrix sender; the local account link becomes
optional.**

- `messages.userId` becomes nullable. `messages.senderMatrixId` (the full
  `@user:server` id) is recorded on every ingested message and on
  API-authored ones.
- The ingest attributes what it can: a sender found in `userProfiles` gets
  the local `userId` *and* the Matrix id; an unknown sender in a known room
  gets `userId = null` and the Matrix id. Unknown *rooms* are still skipped —
  federation doesn't change whose rooms this index covers.
- Display resolves in order: per-server nickname, account name, and for
  remote senders the Matrix id itself — `@ana:their.server` is honest,
  unambiguous, and needs no invented profile.
- **Moderation is unchanged in mechanism.** Redaction of a remote sender's
  message goes through Matrix power levels, which already bind at the room
  layer (T18's fix); the index applies the redaction like any other. What a
  local moderator cannot do is ban a remote *account* — that is their
  homeserver's jurisdiction, and pretending otherwise would be UI fiction.

## What this deliberately does not do

No remote-user profiles, no federated membership rows, no cross-instance
identity mapping. A remote sender is a Matrix id with messages, nothing more.
Every richer treatment (avatars over federation, remote member lists) is
future work that must not block the 0.7 proof.

## The completion criterion

0.7's checkbox closes when a harness stands up **two full instances**, opens
federation between their homeservers, puts one room in both, and proves:
messages cross; both indexes record both senders (one local, one federated);
redactions propagate; and neither instance's `/metrics` or conformance
regresses. That harness is `scripts/e2e-federation.sh`, and it does not exist
yet — this ADR records the shape it will test, not the claim that it passes.

## References

- [ADR 0009](0009-appservice-ingest.md) — the ingest this extends
- [THREAT_MODEL.md](../THREAT_MODEL.md) — T18 (room-layer permissions)
- [docs/ROADMAP.md](../ROADMAP.md) — 0.7
