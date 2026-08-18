# ADR-0013: Voice and video channels over Cloudflare Realtime SFU

**Status:** Accepted
**Date:** 2026-08-18
**Deciders:** xchronusx (owner call, made explicitly)

## Context

Voice channels are the last flagship capability the platform advertises as
future work. The constraints that shaped every earlier decision apply here
too: servers are self-hosted by people who are not operators, the desktop
app can host a server on a laptop, and every capability must be honestly
advertised per-instance rather than assumed. Media servers are the most
operationally hostile component in this whole domain — an SFU needs public
UDP, NAT traversal, and bandwidth that a tunnel-only deployment simply does
not have. Every SOVRGNnet deployment to date is reachable *only* through a
Cloudflare Tunnel, which cannot carry WebRTC media at all.

## Decision

Voice/video rides the **Cloudflare Realtime Serverless SFU**, one Realtime
app per operator, credentials in the server's environment
(`CF_REALTIME_APP_ID` / `CF_REALTIME_APP_SECRET`). The server proxies the
SFU Connection API (sessions/tracks/renegotiate) so the secret never
reaches a browser, and keeps voice presence itself — who is in which
channel, publishing which tracks — because the SFU deliberately has no room
concept. The `voice` capability is advertised only when the credentials are
configured, exactly like `sso` and `e2ee`.

## Options Considered

### Option A: Cloudflare Realtime SFU (chosen)

| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — raw WebRTC client code, but no media infra to run |
| Cost | 1,000 GB/month free, then $0.05/GB; no per-minute billing |
| Scalability | Cloudflare's edge; nothing of ours in the media path |
| Fit | Works behind tunnel-only deployments, which nothing else here does |

**Pros:** zero media servers to operate; works for desktop-hosted servers
(they already can't take inbound UDP); free tier covers a community;
unopinionated API leaves room protocol to us — which is where membership
and permissions already live.
**Cons:** media transits a third party (see Consequences); per-operator
Cloudflare account required to light the capability up.

### Option B: Self-hosted LiveKit

**Pros:** full sovereignty — media never leaves the operator's box; mature
SDKs. **Cons:** demands public UDP/TURN that tunnel-only and
desktop-hosted deployments do not have; a second stateful service to
install, monitor, and upgrade on machines run by non-operators. Rejected
for v1; remains the named path if a sovereignty-first voice mode is wanted
later, since the server-side surface (join/presence/proxy) is provider-
shaped, not Cloudflare-shaped.

### Option C: MatrixRTC

**Pros:** ideologically native. **Cons:** Dendrite's support is immature,
and Element Call's production backend is LiveKit anyway — this is Option B
with extra steps and less control. Rejected.

### Option D: Cloudflare RealtimeKit

**Pros:** fastest to ship. **Cons:** per-minute pricing with **no free
tier**, and its meetings/presets abstractions duplicate the membership
model the server already owns. Rejected.

## Trade-off Analysis

The honest one: this is the first capability where user media transits
infrastructure the operator does not control. Messages stay Matrix + E2EE;
voice packets go through Cloudflare's SFU (DTLS-SRTP encrypted in transit,
but the SFU is a decrypting hop by design — selective forwarding requires
it). That trade is accepted **per-operator and per-capability**: an
operator who configures no credentials runs a fully working server whose
descriptor says `voice: false`, and clients offer nothing. Nobody inherits
the trade silently — which is the same posture SSO took.

## Consequences

- Easier: voice works identically on a VPS, an LXC, and a laptop-hosted
  desktop server, because none of them terminate media.
- Harder: true media sovereignty needs Option B later; the router is
  written provider-shaped to keep that door open.
- Revisit: E2EE voice (insertable streams / SFrame) if it matures; LiveKit
  driver if a sovereignty-first mode is demanded.

## Action Items

1. [x] Create Realtime app `sovrgnnet-voice`; credentials to operators' env
2. [x] `channels.kind` (`text` | `voice`) + migration
3. [x] Server voice router: proxy + presence, membership-gated
4. [ ] Client voice panel (join/leave/mute/camera), Dashboard wiring
5. [ ] Desktop multi-server rail (separate track, same release)
