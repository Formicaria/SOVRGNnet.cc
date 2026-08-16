# ADR 0009 — Matrix becomes the source of record

**Status:** Accepted · August 2026 · ingest and client authoring implemented;
proxy retirement outstanding
**Builds on:** [ADR 0008](0008-client-side-matrix.md) (client-side sessions)
**Enables:** ADR 0008 stage 4 (E2EE)

## Context

Every message today is composed by the instance: the client asks the API, the
API sends to Matrix with the user's server-held session, and the API writes the
database row. The database is authoritative and Matrix is, in practice, a
delivery mechanism.

That ordering is exactly backwards for end-to-end encryption, and not by a
little. An encrypted event is *composed on the device* — the server cannot
write it, because writing it requires the keys whose absence is the entire
point. And once events the server cannot read exist, a database that stores
message *content* as its primary record has nothing to store.

So two architectural facts have to change before a single line of Olm ships:

1. **Clients must be able to author events themselves** — their own session,
   their own compose, their own send.
2. **The database must become an index built from Matrix, not a ledger written
   beside it** — and that index must function while blind to content.

This ADR makes both true for plaintext, so that stage 4 changes the *payload*
rather than the architecture.

## The recording problem

If a client sends via its own Matrix session, how does the instance's database
find out? Three candidates:

**Per-user server-side sync loops.** The instance already holds a session per
user; it could sync as each of them. Rejected: N long-poll loops for N users is
a resource model that punishes the instance for having members, and every loop
is another place event ordering can diverge.

**The instance polls rooms it knows about.** Rejected: polling is what this
whole line of work exists to remove, and `/messages` pagination as a
reconciliation mechanism is a correctness bug factory.

**An application service.** The homeserver pushes every event in its namespace
to a registered endpoint, in order, with retries, exactly once per transaction
id. This is the mechanism Matrix built for bridges — software whose entire job
is to mirror rooms into another system — which is precisely what our database
is about to be. Chosen.

## Decision

**The instance registers as an application service with its homeserver and
ingests events from transaction pushes.**

- `PUT /_matrix/app/v1/transactions/{txnId}`, authenticated by the `hs_token`
  the registration file shares between homeserver and instance. Wrong or
  missing token is a 403 and is logged, because a push endpoint that accepts
  unauthenticated writes is a message-forgery API.
- Ingest is **idempotent by event id** (the messages table's unique
  `matrixEventId` does the work) and **transactions are acknowledged wholesale**
  — Matrix retries the whole transaction until it gets a 200, so a permanent
  failure on one event must not wedge the queue behind it. Events that cannot
  be attributed (sender unknown to this instance, room not one of ours) are
  skipped and counted, not errors.
- `m.room.message` from a known sender in a known channel becomes a message
  row. Events the instance itself just recorded via the API path dedupe on
  event id — during migration both paths run and the row wins whoever writes
  first.
- `m.room.redaction` removes the redacted event's row.
- **`m.room.encrypted` becomes a row with empty content and `encrypted: true`.**
  The index stays complete — ordering, sender, timestamp, unread counts all
  work — while the instance holds nothing readable. This is the content-blind
  shape stage 4 needs, implemented and tested before any ciphertext exists.
- The registration file gives the appservice an *empty namespace claim* — it
  exists to observe, not to own user ids or aliases — and `sender_localpart`
  is a dedicated service user that never posts.

**Clients author events when the instance says both halves work.** A new
`eventIngest` capability is true only when the appservice tokens are
configured. A client sends through its own Matrix session only when
`clientMatrix && eventIngest` — otherwise authoring through Matrix would
produce messages the instance never records and polling-fallback members never
see. The API send path stays, both as the fallback and as the migration
period's second writer.

## Consequences

**The database's role changes from ledger to index.** This is the actual
architectural change, and it is deliberately made while everything is still
plaintext and both write paths run. When stage 4 lands, encrypted rooms are a
payload change: the ingest already stores what it cannot read.

**A new authenticated surface exists.** The transaction endpoint is
hs_token-gated, loopback-reachable in every stock deployment, and does not
serve reads. THREAT_MODEL gains it as an asset; the tokens are secrets with
the same standing as the shared registration secret.

**Ordering truth moves to Matrix.** Two writers exist during migration (API
path and ingest), reconciled by event id. The API path's row and the ingested
row are the same row. When the proxy send path is eventually retired, the
ingest is the only writer and the question disappears.

**Operators must wire a registration file.** The template ships in
`dendrite/appservice.yaml.template` with the two env variables documented
beside it; generating both during `install.sh` is follow-up work, noted so it
isn't mistaken for done. An instance that never configures it keeps today's
behaviour exactly — the capability stays false, clients keep sending through
the API.

## Alternatives considered

**Skip recording; serve history from Matrix.** The end state E2EE actually
wants — but it deletes the instance API's history endpoint out from under the
web client and the polling fallback in one move. The index earns its keep for
search, moderation, and non-Matrix data (files, roles); shrinking it further is
future work, not a blocker.

**Pusher (`/_matrix/push/v1/notify`).** Push gateways get notification
summaries, not reliable ordered event streams. Wrong tool.

**Dendrite's output kafka/naffka streams directly.** Reaching into the
homeserver's internals couples us to its storage format and forecloses every
other homeserver. The appservice API is the stable, specified boundary.

## References

- [Matrix Application Service API](https://spec.matrix.org/v1.11/application-service-api/)
- [ADR 0008](0008-client-side-matrix.md) — sessions, sync, and the staging this continues
- [THREAT_MODEL.md](../THREAT_MODEL.md) — T8, T17, and the new ingest surface
