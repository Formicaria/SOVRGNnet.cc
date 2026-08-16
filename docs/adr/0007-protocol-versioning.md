# ADR 0007 — The protocol is versioned separately from the application

**Status:** Accepted · August 2026 · implemented in v0.4.0

## Context

Until now "SOVRGNnet v0.3.0" meant one thing: the version of this codebase.
Client and server shipped together and were assumed to match, which was true
while there was effectively one instance.

[ADR 0001](0001-multi-server-client.md) broke that assumption. A client now
connects to several instances at once, each run by a different person on
different hardware with different priorities about when to touch a working
machine. Some will upgrade the week a release lands. Some will upgrade when
something breaks. Some never will.

That produces a question every request has to answer: *can these two talk?*

The naive answer is to compare application versions. It fails immediately.
A v0.3.0 client and a v0.4.0 instance are almost always compatible — the
release added a backup format and some endpoints, nothing a client depends on.
Refusing the connection would be wrong. Allowing it because 0.3 and 0.4 look
close would also be wrong, since nothing guarantees that.

The deeper problem is what version-matching implies. If instances have to track
our releases to stay usable, then every instance is downstream of our release
cadence, and an operator who declines an upgrade gradually finds their instance
stops working with everyone else's. That is a dependency on us wearing
different clothes, and removing exactly that dependency is the point of the
project.

Three further problems surfaced at the same time:

**Feature detection was ad hoc.** The client checked whether `matrixBaseUrl`
was non-null to infer whether direct Matrix sync was possible, and read an
`encryption` boolean that was itself derived from configuration. Inferring
capabilities from incidental fields means a configuration change silently
becomes a capability claim — which is precisely what happened: `encryption` was
computed from whether the homeserver had a public URL, so giving the homeserver
an address would have made the instance claim end-to-end encryption it does not
have.

**"Anyone can write another implementation" was unfalsifiable.** A stated goal
with nothing to check it against.

**There was no way to be an instance without being this codebase.** Everything
normative was implicit in the TypeScript.

## Decision

**Version the protocol separately, and make compatibility a single rule.**

```
SOVRGNnet Server:   0.4.0     ← application
SOVRGNnet Client:   0.4.0     ← application
SOVRGN Protocol:    1.0       ← the contract
```

Compatibility is **the same protocol major version**, and nothing else.
Application versions are informational and never gate a connection. Minor
versions only ever add capabilities, so an older party simply doesn't know
about the additions and never asks for them.

**Capabilities are explicit, typed, and default to false.**

```ts
capabilities: {
  messaging, media, e2ee, voice, federation,
  sso, publicRegistration, clientMatrix, portableBackup
}
```

The default direction is the whole design. An instance that has never heard of
a capability must read as "doesn't have it", never as "probably fine".
Optimistic defaults are how a client ends up offering a feature that silently
does nothing, and the person blames their own network.

**Discovery is unauthenticated and CORS-open.** It has to be: a client
connecting to an instance it has never seen has no credentials yet, and
cross-origin is the entire point of a multi-instance client. Nothing there
exposes members, channels, or messages.

**Degrading gracefully means explaining, not hiding.** `explainMissing()`
returns a human sentence. Someone whose friend's instance has no voice should
learn that, rather than wonder where the button went.

**A conformance suite defines "is a SOVRGNnet instance" executably.**

```bash
pnpm conformance https://any-instance.example
```

## Consequences

**Instances upgrade on their own schedule.** An operator who leaves a machine
alone for a year still has a working instance, and clients still connect to it.
That is the property this ADR exists to produce.

**Adding a capability is cheap; removing one is expensive.** New capabilities
arrive in a minor version defaulting to false. Removing one, or changing what
it means, requires a major bump — which breaks every older client, so it should
be rare and deliberate.

**`/api/instance` now serves two shapes at once.** The v0.1–v0.3 field layout
and the formal descriptor come back in one response, so existing clients keep
working. The old fields are deprecated and will not be removed inside major
version 1. This is a cost paid deliberately: an interoperability layer that
breaks interoperability on its first release would be self-refuting.

**`server.id` format is normative.** Exactly 16 lowercase hex characters,
SHA-256 of `sovrgnnet:instance:<matrix server name>` truncated. This is
stricter than it needs to be for identification alone, and the reason is
security rather than tidiness: the id is the audience of every identity token,
where an ambiguous value means two instances could both plausibly claim the
same token.

**The conformance suite found a bug on its first run.** Pointed at a live
process with no database, it revealed `/ready` reporting `database: "ok"` —
the endpoint called a query that catches its own errors and returns null by
design. A readiness check that cannot fail is not a check. An orchestrator
would have routed traffic to a broken instance indefinitely.

That is the argument for the suite in miniature. The bug was invisible to unit
tests and to reading the code, which looks like it checks something.

**E2EE is now impossible to claim by accident.** `E2EE_AVAILABLE` is a
hard-coded constant with tests guarding it, and the conformance suite fails any
instance advertising `e2ee` without `clientMatrix` — because an instance
proxying all Matrix traffic holds the keys, and claiming otherwise asserts a
protection the architecture cannot provide.

**More surface to keep honest.** Three endpoints became five, and every
capability is a promise that has to stay true. The self-consistency checks
exist so those promises are verified mechanically rather than by remembering.

## Alternatives considered

**Compare application versions.** Rejected: makes every instance downstream of
our release cadence, which is the dependency the project exists to remove.

**Semantic versioning on the protocol, with patch.** Rejected: a protocol has
no meaningful patch level. A change either affects the contract or it doesn't.
Two components is the honest shape.

**Capabilities defaulting to true.** Rejected. It reads as the friendlier
choice — assume things work — and it means an old instance claims everything
it has never heard of. Failures then appear at the moment of use, to the user,
with no explanation.

**Feature flags negotiated per session.** Rejected as premature. A static
descriptor covers every case that exists, and per-session negotiation is a
protocol requiring its own versioning.

**Skip the conformance suite until a second implementation exists.** Rejected,
and the ordering matters: writing the suite first is what makes a second
implementation possible. Waiting means the first alternative implementation
defines conformance by whatever it happens to do.

## References

- [`shared/protocol.ts`](../../shared/protocol.ts) — the contract
- [`shared/conformance.ts`](../../shared/conformance.ts) — the checks
- [docs/PROTOCOL.md](../PROTOCOL.md) — the specification
- [ADR 0001](0001-multi-server-client.md) — multi-instance client, which forced this
