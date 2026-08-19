import { SignJWT, jwtVerify } from "jose";

/**
 * Voice channels over a per-instance LiveKit SFU — ADR 0013, as superseded.
 *
 * The first cut of this file proxied Cloudflare's SFU, and the owner's
 * reversal deleted that world in a sentence: hundreds of thousands of
 * instances, each housing its own voice backend, nothing routed through any
 * account SOVRGN holds. So the server's whole job shrinks to the one thing
 * only it can do: **decide who may enter which room, and say so in a signed
 * token.** Media never touches this process — the client connects straight
 * to the operator's own LiveKit server and stays there.
 *
 * Configured with three values, all pointing at the operator's machine:
 *   LIVEKIT_URL         wss://voice.example.com (or ws://host:7880 on LAN)
 *   LIVEKIT_API_KEY     from the LiveKit server's keys file
 *   LIVEKIT_API_SECRET  its pair
 *
 * Absent, the instance advertises `voice: false` and refuses plainly — the
 * sso posture. Present, `voice: true` is honest because the operator runs
 * the thing that makes it true. Isolation needs no code here anymore:
 * per-channel because a token admits exactly one room, per-instance because
 * every instance signs with its own secret against its own SFU. There is no
 * shared anything left to cross.
 *
 * The token is LiveKit's documented access-token shape: an HS256 JWT whose
 * issuer is the API key and whose `video` claim carries the room grant.
 * Minted with `jose`, which the workspace already ships — a LiveKit server
 * SDK dependency would be forty packages to sign one small JWT.
 */

/** Short-lived on purpose: it admits you; the connection then stands on its own. */
const TOKEN_TTL = "10m";

export function voiceConfigured(): boolean {
  return Boolean(
    process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET
  );
}

export function voiceUrl(): string {
  return (process.env.LIVEKIT_URL ?? "").replace(/\/+$/, "");
}

/**
 * One room per channel, named so a token can never be mistaken for another
 * channel's. The channel id is the instance's own; two instances can both
 * have a room named voice-3 and it means nothing, because each one's tokens
 * only verify against its own SFU's secret.
 */
export function roomName(channelId: number): string {
  return `voice-${channelId}`;
}

/**
 * The admission decision, signed. Everything above this call — membership,
 * channel kind, configuration — already happened in the router; this just
 * puts the verdict in a form the operator's SFU will believe.
 */
export async function mintVoiceToken(options: {
  channelId: number;
  /** Stable per-user identity; LiveKit treats a rejoin under it as the same participant. */
  identity: string;
  /** What other participants see. */
  displayName: string;
}): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !secret) {
    throw new Error("Voice is not configured on this instance.");
  }
  return new SignJWT({
    name: options.displayName,
    video: {
      room: roomName(options.channelId),
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(apiKey)
    .setSubject(options.identity)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(new TextEncoder().encode(secret));
}

/** Tests only: verify a minted token the way the SFU would. */
export async function __verifyVoiceTokenForTests(token: string) {
  const secret = process.env.LIVEKIT_API_SECRET ?? "";
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
  });
  return payload;
}
