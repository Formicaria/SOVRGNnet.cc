# Dendrite v0.15.2: permanent to-device loss on a cold pipeline after a room-creation burst

Evidence file for an upstream report against
[element-hq/dendrite](https://github.com/element-hq/dendrite), and the
record of why `warmToDevicePipeline()` exists in this codebase
(`server/matrixService.ts`, called from server boot).

## Symptom

`PUT /_matrix/client/v3/sendToDevice/...` returns 200, and the message is
gone: never delivered to the target device's `/sync`, never returned by a
fresh initial sync, zero rows in `syncapi_send_to_device`. Once a device
has lost its first message this way, **every later to-device message to it
is also lost** — including plain unencrypted ones sent 25 seconds later.
Room-event delivery keeps working throughout. Nothing is logged: no panic,
no `level=error`, no `level=warning` beyond boot noise, container restart
count 0, one NATS boot banner.

For an E2EE client the visible failure is a second device that can never
decrypt: the Megolm room key was the message that vanished.

## Trigger — both conditions must hold

1. **Cold pipeline.** The internal `OutputSendToDeviceEvent` JetStream
   stream has never carried a message since Dendrite booted.
2. **Send adjacent to a create-burst.** The first to-device message
   arrives within a few seconds (< ~8s) after a burst of room-creation
   traffic — in our reproduction: `createRoom` (space, room v10),
   `createRoom` (restricted channel), `PUT m.space.child`,
   `PUT m.room.encryption`, performed twice by an existing user, with
   invite/join and client-session traffic around them.

## Evidence chain (16 controlled runs, fresh stack + volumes each)

Deterministically **red** — 12+ consecutive runs: full harness walk
(registration, room creation, invites, joins, messages, a second
community creation), then two fresh devices exchange the first-ever
to-device message ~1–2s after the burst. Sender's wire (logged verbatim):
`keys/claim` returns the target's OTK, `sendToDevice` names the target
user and device, Dendrite answers 200. Receiver: zero events, fresh
initial sync empty, `syncapi_send_to_device` empty. A plain
`m.*.ping` to the same device 25s later: also lost.

Deterministically **green**, each verified against a red baseline in the
same session:

- **Warm stream:** one to-device ping between two bystander accounts
  before the walk starts (accounts in no rooms). Entire walk passes,
  including full E2EE exchange for the burst-adjacent users.
- **8s gap:** identical walk, no extra traffic, `sleep 8` between the
  burst and the first send. Passes.
- **75s gap:** passes.
- **Interleaved traffic:** eight consecutive create-bursts with a ping
  after each — every ping delivered (the previous ping keeps the stream
  warm for the next round).

Ruled out by direct evidence: client SDK misbehaviour (wire ledger shows
correct claim + send), container restart/OOM (`docker inspect`), NATS
restart (one boot banner across the full log), the v0.15.0 helpers.go
`Fatal`→`Warn`+return consumer-death path (its warning line never
appears), logout/device-deletion (no logout in the minimal red variant).
Not reproducible on a bare homeserver with the same create sequence and
no surrounding client traffic — the burst context matters. Downgrade to
v0.14.1 is not a control: pre-MSC3967 UIA gates cross-signing upload.

## Suspected area

`OutputSendToDeviceEvent` is an interest-policy stream
(`setup/jetstream/streams.go`); a publish without consumer interest is
discarded by design, with the producer none the wiser. The evidence fits
the syncapi consumer's interest lapsing (or its stream position wedging)
during the burst while the stream is empty, and the first publish landing
in that gap — after which that device's delivery never recovers. We did
not identify the exact line; the reproduction above should let someone
who knows the syncapi internals do so quickly.

## Environment

`ghcr.io/element-hq/dendrite-monolith:v0.15.2`, PostgreSQL 16, embedded
NATS 2.11.7, single-container monolith, one appservice registered
(`.*` users, non-exclusive; also reproduced with no appservice), room
version 10. Clients: matrix-js-sdk 42.1.0 (Rust crypto 0.18.0 /
Vodozemac 0.10.0) for E2EE runs; plain `fetch` for the unencrypted
pings.

## Local mitigation

At boot the SOVRGNnet server sends one no-op to-device ping to itself
(probe account, deterministic password derived from the registration
shared secret, fixed device id). The stream is warm before any user can
send a room key, which per the evidence above prevents the loss
entirely. Remove once fixed upstream.
