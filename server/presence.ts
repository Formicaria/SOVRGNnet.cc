/**
 * Who's typing, and who's around.
 *
 * Both are deliberately in-memory and deliberately app-level. Typing and
 * presence are ephemeral, worthless a few seconds later, and not worth a
 * database write per keystroke — losing all of it on restart costs nothing.
 *
 * Typing notifications are also pushed to Matrix so third-party clients see
 * them, but this registry is what the SOVRGNnet UI reads, because reading
 * them back from Matrix would mean holding a /sync stream we don't have yet.
 *
 * A single-process store like this is correct for one app container, which is
 * the entire deployment story today. Running several would want Redis.
 */

const TYPING_TTL_MS = 6000;
const ONLINE_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;

/** channelId -> userId -> expiry timestamp */
const typing = new Map<number, Map<number, number>>();
/** userId -> last time we heard from them */
const lastSeen = new Map<number, number>();

export function noteTyping(channelId: number, userId: number): void {
  let channel = typing.get(channelId);
  if (!channel) {
    channel = new Map();
    typing.set(channelId, channel);
  }
  channel.set(userId, Date.now() + TYPING_TTL_MS);
  noteActivity(userId);
}

export function clearTyping(channelId: number, userId: number): void {
  typing.get(channelId)?.delete(userId);
}

/** User ids currently typing in a channel, never including the asker. */
export function getTypingUserIds(channelId: number, excludeUserId: number): number[] {
  const channel = typing.get(channelId);
  if (!channel) return [];

  const now = Date.now();
  const active: number[] = [];
<<<<<<< HEAD
  for (const [userId, expiresAt] of channel) {
=======
  Array.from(channel.entries()).forEach(([userId, expiresAt]) => {
>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
    if (expiresAt <= now) {
      channel.delete(userId);
    } else if (userId !== excludeUserId) {
      active.push(userId);
    }
<<<<<<< HEAD
  }
=======
  });
>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
  return active;
}

export function noteActivity(userId: number): void {
  lastSeen.set(userId, Date.now());
}

export function isOnline(userId: number): boolean {
  const seen = lastSeen.get(userId);
  return seen !== undefined && Date.now() - seen < ONLINE_TTL_MS;
}

export function onlineUserIds(userIds: number[]): Set<number> {
  return new Set(userIds.filter(isOnline));
}

/** Drop expired entries so an idle instance doesn't grow forever. */
export function sweep(): void {
  const now = Date.now();
<<<<<<< HEAD
  for (const [channelId, channel] of typing) {
    for (const [userId, expiresAt] of channel) {
      if (expiresAt <= now) channel.delete(userId);
    }
    if (channel.size === 0) typing.delete(channelId);
  }
  for (const [userId, seen] of lastSeen) {
    if (now - seen > ONLINE_TTL_MS * 10) lastSeen.delete(userId);
  }
=======
  Array.from(typing.entries()).forEach(([channelId, channel]) => {
    Array.from(channel.entries()).forEach(([userId, expiresAt]) => {
      if (expiresAt <= now) channel.delete(userId);
    });
    if (channel.size === 0) typing.delete(channelId);
  });
  Array.from(lastSeen.entries()).forEach(([userId, seen]) => {
    if (now - seen > ONLINE_TTL_MS * 10) lastSeen.delete(userId);
  });
>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
}

// unref() so this timer never holds the process open on shutdown.
const sweeper = setInterval(sweep, SWEEP_INTERVAL_MS);
if (typeof sweeper.unref === "function") sweeper.unref();

/** Test helper — reset all state between cases. */
export function __resetForTests(): void {
  typing.clear();
  lastSeen.clear();
}
