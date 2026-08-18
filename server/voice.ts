/**
 * Voice channels over the Cloudflare Realtime SFU — ADR 0013.
 *
 * The schema had `voice` channels since the bootstrap and nothing behind
 * them: every layer but the last one. This is the last one. The server does
 * two jobs here and deliberately no more:
 *
 * 1. **Proxy the SFU Connection API.** The app secret authorizes every SFU
 *    call and must never reach a browser, so clients hand their SDP to the
 *    server and the server speaks to Cloudflare. Sessions and tracks are
 *    Cloudflare's; nothing media-shaped runs on this box — which is the
 *    entire reason a tunnel-only deployment can have voice at all.
 *
 * 2. **Keep presence.** The SFU has no room concept on purpose; "who is in
 *    #general-voice, publishing which tracks" is membership-adjacent state
 *    and lives where membership lives. In memory, not the database: presence
 *    is a fact about running processes, and a restart that forgets it is
 *    telling the truth.
 *
 * Configured with CF_REALTIME_APP_ID / CF_REALTIME_APP_SECRET. Absent, the
 * instance advertises `voice: false` and every procedure refuses plainly —
 * the same posture SSO takes. The provider surface is kept deliberately
 * narrow (newSession / newTracks / renegotiate / presence) so a LiveKit
 * driver could sit behind the same shape if media sovereignty is wanted
 * later; see the ADR's Option B.
 */

const API_BASE = "https://rtc.live.cloudflare.com/v1";

/** Seconds without a heartbeat before a participant is presumed gone. */
const PRESENCE_TTL_SECONDS = 20;

export function voiceConfigured(): boolean {
  return Boolean(
    process.env.CF_REALTIME_APP_ID && process.env.CF_REALTIME_APP_SECRET
  );
}

/**
 * Swapped by tests so the proxy is testable without dialing Cloudflare —
 * the same arrangement matrixService and the OAuth broker use.
 */
let sfuFetch: typeof fetch = (...args) => fetch(...args);
export function __setSfuFetchForTests(impl: typeof fetch): void {
  sfuFetch = impl;
}

async function sfu(path: string, body: unknown, method = "POST"): Promise<any> {
  const appId = process.env.CF_REALTIME_APP_ID;
  const secret = process.env.CF_REALTIME_APP_SECRET;
  if (!appId || !secret) {
    throw new Error("Voice is not configured on this instance.");
  }
  const res = await sfuFetch(`${API_BASE}/apps/${appId}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const result: any = await res.json().catch(() => null);
  if (!res.ok || result?.errorCode) {
    throw new Error(
      result?.errorDescription ?? `SFU answered ${res.status} without detail`
    );
  }
  return result;
}

/** Create the caller's SFU session from their initial offer. */
export function newSession(offerSdp: string) {
  return sfu("/sessions/new", {
    sessionDescription: { type: "offer", sdp: offerSdp },
  });
}

export type TrackRequest =
  | { location: "local"; mid: string; trackName: string }
  | { location: "remote"; sessionId: string; trackName: string };

/** Publish local tracks or pull remote ones on an existing session. */
export function newTracks(
  sessionId: string,
  tracks: TrackRequest[],
  offerSdp?: string
) {
  const body: Record<string, unknown> = { tracks };
  if (offerSdp) {
    body.sessionDescription = { type: "offer", sdp: offerSdp };
  }
  return sfu(`/sessions/${encodeURIComponent(sessionId)}/tracks/new`, body);
}

/** Complete the renegotiation the SFU asked for when tracks were pulled. */
export function renegotiate(sessionId: string, answerSdp: string) {
  return sfu(
    `/sessions/${encodeURIComponent(sessionId)}/renegotiate`,
    { sessionDescription: { type: "answer", sdp: answerSdp } },
    "PUT"
  );
}

// --------------------------------------------------------------- presence

export type VoiceParticipant = {
  userId: number;
  username: string;
  /** Their SFU session — what others pull tracks from. */
  sessionId: string;
  /** Track names they've published, e.g. ["mic-…", "cam-…"]. */
  tracks: string[];
  lastSeenAt: number;
};

const rooms = new Map<number, Map<number, VoiceParticipant>>();

function room(channelId: number): Map<number, VoiceParticipant> {
  let r = rooms.get(channelId);
  if (!r) {
    r = new Map();
    rooms.set(channelId, r);
  }
  return r;
}

function sweep(channelId: number): void {
  const r = rooms.get(channelId);
  if (!r) return;
  const cutoff = Date.now() - PRESENCE_TTL_SECONDS * 1000;
  for (const [userId, p] of r) {
    if (p.lastSeenAt < cutoff) r.delete(userId);
  }
  if (r.size === 0) rooms.delete(channelId);
}

/** Join or refresh: one presence per user per channel, latest session wins. */
export function joinPresence(
  channelId: number,
  participant: Omit<VoiceParticipant, "lastSeenAt">
): void {
  room(channelId).set(participant.userId, {
    ...participant,
    lastSeenAt: Date.now(),
  });
}

/** Update published tracks and bump liveness. */
export function announceTracks(
  channelId: number,
  userId: number,
  tracks: string[]
): void {
  const p = rooms.get(channelId)?.get(userId);
  if (p) {
    p.tracks = tracks;
    p.lastSeenAt = Date.now();
  }
}

export function heartbeat(channelId: number, userId: number): void {
  const p = rooms.get(channelId)?.get(userId);
  if (p) p.lastSeenAt = Date.now();
}

export function leavePresence(channelId: number, userId: number): void {
  rooms.get(channelId)?.delete(userId);
  sweep(channelId);
}

/** Everyone currently in the channel, stale entries swept on read. */
export function participants(channelId: number): VoiceParticipant[] {
  sweep(channelId);
  return [...(rooms.get(channelId)?.values() ?? [])];
}

/** Tests only: forget everything. */
export function __resetPresenceForTests(): void {
  rooms.clear();
}
