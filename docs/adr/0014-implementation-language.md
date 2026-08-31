# ADR-0014: Implementation language and the shape of the restructure

**Status:** Proposed — owner decision pending
**Date:** 2026-08-30
**Deciders:** xchronusx

## Context

Mid-way through cornering the v0.7.1 release blocker — Dendrite v0.15.2
silently discarding all to-device messages after a second `servers.create`
(four plain CS-API requests) — the owner asked the question every project
should face before its 1.0: is TypeScript the right language for this at
all? What is Discord built in? Should we restructure and translate now,
while the codebase is still one person's size?

This ADR answers with measured facts rather than instinct, because the
instinct on both sides is suspect: "rewrite it properly" always looks
cheapest right before a release, and "never rewrite" is how projects
calcify around early mistakes.

## What Discord is actually built in

Elixir runs the real-time gateway — each guild is an isolated BEAM process,
which is how one hot community cannot take down the rest. Rust handles hot
paths (Read States moved from Go to Rust over GC latency spikes; Elixir is
extended with Rust NIFs for serialization and permission checks). Python
serves the API layer and tooling, C++ the voice/video media engine,
ScyllaDB stores messages. The client is React + TypeScript in Electron.

The load-bearing observation: Discord needed Elixir and Rust because they
built their own real-time distribution core — nothing off the shelf existed
at their scale. The layers of Discord that correspond to the code in this
repository — client and API coordination — are TypeScript and Python there.

## What this repository actually is

Measured today (production + tests, excluding build artifacts and
`node_modules`):

| Layer                      | Lines   | Language        |
| -------------------------- | ------- | --------------- |
| client/src                 | ~12,000 | TypeScript/TSX  |
| server (~12,200 is tests)  | ~19,700 | TypeScript      |
| shared                     | ~5,500  | TypeScript      |
| scripts (e2e, tooling)     | ~9,000  | TypeScript/sh   |
| desktop (Tauri supervisor) | ~3,800  | Rust (~1,325) + TS |
| identity + hub service     | ~4,400  | TypeScript      |

And the delegated components, which are where the hard concurrent-systems
work deliberately lives: Dendrite (Go) for messaging, federation, and
E2EE transport; Kubo (Go) for content addressing; LiveKit (Go, planned)
for voice SFU; Postgres for storage.

So the honest description: ~40k lines of owned coordination-and-UI code in
TypeScript, one Rust native shell, and the gateway-equivalent layer — the
part Discord wrote in Elixir — outsourced to purpose-built servers we
self-host. We already run a four-language stack; the question is whether
the owned 40k lines are in the wrong one.

## The layer that is actually failing

The release blocker lives in Dendrite — written in Go, a compiled language
with a strong concurrency story. Language did not save it. What is hurting
us is not our stack; it is that **Dendrite is in maintenance mode
upstream** (security fixes only, since late 2024), so bugs like ours may
never be fixed by anyone but us. That reframes the owner's question: the
highest-value "translation" available is not rewriting our TypeScript —
it is re-choosing the delegated homeserver.

Current homeserver landscape: **Synapse** (Python) is the actively
developed reference, maintained by Element, and supports every mechanism
this stack depends on — shared-secret `/_synapse/admin/v1/register`
(which our provisioning literally already speaks), appservices, restricted
rooms, MSC3967. **Continuwuity** (Rust, community fork of conduwuit) is
actively maintained with strong performance; its appservice support exists
but its compatibility with our exact shared-secret registration endpoint
is *unverified* and must be probed before it is a candidate in earnest.
**Dendrite** delivers the best performance-per-resource of the three but
is the one nobody is fixing.

## Options

**A. Rewrite the server layer in Rust (axum + matrix-rust-sdk).**
matrix-rust-sdk is mature — it is the same engine underneath our client
crypto — and Tauri means Rust is already in-tree. Costs: rewrite ~7,500
production lines plus regain the confidence of ~12,000 lines of tests that
took months of falsified theories to harden (auth, backup/restore, ingest,
invite policy); lose tRPC's end-to-end types shared with the client
(replaced by OpenAPI codegen, a real downgrade in day-to-day velocity);
two to four months of solo momentum. Buys performance headroom this
architecture does not need: federation spreads load across instances by
design, so a single instance serves a community, not the world.

**B. Rewrite in Elixir (Phoenix).** The best runtime on earth for the
problem Discord had — and the problem we deliberately do not have, because
Dendrite/Synapse is our gateway. No maintained server-side Matrix SDK in
Elixir, so we would hand-roll the CS API exactly as we do in TypeScript
today: parity, not progress. Loses the shared types entirely. Three to
five months. Fits a future where we replace the homeserver with our own
gateway; that future is not roadmapped.

**C. Rewrite in Go.** Ecosystem alignment with every delegated component,
mautrix-go is mature and battle-tested by the bridge ecosystem, simplest
concurrency upgrade from Node. Still forfeits tRPC and two months minimum.
The strongest of the rewrite options and still not worth it now, for the
same reason as A: the bottleneck is not our layer.

**D. Keep TypeScript; restructure the delegation — swap the homeserver.**
Replace maintenance-mode Dendrite with actively-maintained Synapse (or
Continuwuity, pending the compat probe). Cost is measured in days:
compose service, config template, docs, one full e2e walk — our Matrix
surface is the portable CS API throughout, `/_synapse/admin/v1/register`
included. The parked repro branch is the decision instrument: run
`E2E_REPRO=1` against Dendrite (expect red), point the same script at a
Synapse container (expect green), and the swap is evidence-backed rather
than hopeful. This option also directly unblocks v0.7.1 if the loss proves
Dendrite-specific — the remedy and the restructure become the same commit.

**E. Standing criteria for future Rust carve-outs.** Not a rewrite: a
door. When a measured hot path emerges — profiling evidence of event-loop
saturation or GC-induced latency at real load, behind an isolatable HTTP
boundary — that one service is carved into Rust behind the same contract,
strangler-style. The supervisor proves the toolchain is already wired.

## Decision

Proposed: **D now, E on the books, A/B/C declined without profiling
evidence.** The client stays React + TypeScript — the same choice Discord
makes for that layer with effectively unlimited resources. The server
stays TypeScript because it is a coordination layer whose entire risk
profile lives in correctness (already paid for in tests), not throughput.
The restructure that is real is the homeserver swap, and it is cheap,
evidence-driven, and release-unblocking.

## Consequences

- The v0.7.1 rail resumes immediately under D: repro against Dendrite,
  counter-probe against Synapse, swap, full preflight, tag.
- ~19,700 lines of server TypeScript and their test confidence are
  preserved; no momentum loss.
- We accept Node's honest limits knowingly: single-threaded event loop per
  process, boundary-only runtime types. E is the escape hatch, gated on
  evidence rather than anxiety.
- Synapse costs more RAM per instance than Dendrite — real, and worth
  stating in docs/HOSTING.md if the swap lands. Continuwuity may recover
  that footprint later if its compat probe passes.
- If a future roadmap item makes us build our own real-time core (custom
  sync fanout beyond Matrix), this ADR must be revisited — that is the
  workload Elixir/Rust exist for, and no amount of TypeScript affection
  should survive contact with it.
