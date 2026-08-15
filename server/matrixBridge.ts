import { TRPCError } from "@trpc/server";
import * as db from "./db";
import * as matrix from "./matrixService";

/**
 * Bridge between SOVRGNnet users and their Matrix accounts.
 * Provisions on first use; credentials live only in our database.
 */
export async function ensureMatrixCredentials(
  appUserId: number
): Promise<matrix.MatrixCredentials> {
  const existing = await db.getMatrixCredentials(appUserId);
  if (existing) return existing;

  try {
    const creds = await matrix.registerOrLogin(appUserId);
    await db.saveMatrixCredentials(appUserId, creds.userId, creds.accessToken);
    return creds;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Matrix provisioning failed";
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Messaging backend unavailable: ${message}`,
    });
  }
}

/** Join the space and every channel room of a server. */
export async function joinServerRooms(
  accessToken: string,
  spaceRoomId: string,
  channelRoomIds: string[]
): Promise<void> {
  await matrix.joinRoom(accessToken, spaceRoomId);
  for (const roomId of channelRoomIds) {
    try {
      await matrix.joinRoom(accessToken, roomId);
    } catch {
      // Best-effort: a single unjoinable room shouldn't block server join.
    }
  }
}

export async function requireServerMembership(
  serverId: number,
  userId: number
): Promise<void> {
  const isMember = await db.isServerMember(serverId, userId);
  if (!isMember) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this server.",
    });
  }
}

/** Every room of a server: the space itself plus each channel. */
export async function serverRoomIds(serverId: number): Promise<string[]> {
  const server = await db.getServerById(serverId);
  if (!server) return [];
  const channels = await db.getChannelsByServer(serverId);
  return [server.matrixRoomId, ...channels.map(c => c.matrixRoomId)];
}

/**
 * Mirror an app role onto Matrix power levels in every room of a server.
 *
 * Best-effort on purpose: SOVRGNnet's own permission checks are what actually
 * gate the API, and a homeserver hiccup shouldn't fail a role change. This
 * keeps third-party Matrix clients showing the same picture.
 */
export async function syncPowerLevels(
  serverId: number,
  actingUserId: number,
  targetUserId: number,
  level: number
): Promise<void> {
  const [creds, targetMatrixId] = await Promise.all([
    db.getMatrixCredentials(actingUserId),
    db.getMatrixUserId(targetUserId),
  ]);
  if (!creds || !targetMatrixId) return;

  for (const roomId of await serverRoomIds(serverId)) {
    try {
      await matrix.setPowerLevel(creds.accessToken, roomId, targetMatrixId, level);
    } catch {
      // A room we can't set levels in doesn't invalidate the app-side change.
    }
  }
}

/** Remove or ban a user from every room of a server. Best-effort. */
export async function removeFromServerRooms(
  serverId: number,
  actingUserId: number,
  targetUserId: number,
  mode: "kick" | "ban",
  reason?: string
): Promise<void> {
  const [creds, targetMatrixId] = await Promise.all([
    db.getMatrixCredentials(actingUserId),
    db.getMatrixUserId(targetUserId),
  ]);
  if (!creds || !targetMatrixId) return;

  for (const roomId of await serverRoomIds(serverId)) {
    try {
      if (mode === "ban") {
        await matrix.banUser(creds.accessToken, roomId, targetMatrixId, reason);
      } else {
        await matrix.kickUser(creds.accessToken, roomId, targetMatrixId, reason);
      }
    } catch {
      // The app-side membership row is authoritative for our own UI.
    }
  }
}
