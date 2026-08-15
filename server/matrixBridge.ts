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
