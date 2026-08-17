import { TRPCError } from "@trpc/server";
import * as db from "./db";
import { e2eeAvailable } from "./instance";
import * as matrix from "./matrixService";

/**
 * Create a channel room, encrypted if this instance can manage it at all.
 *
 * Encryption is the default and there is no per-channel choice — a lock that
 * has to be found and switched on is a lock most conversations never get, and
 * "why would anyone want the insecure option" is the right question to ask of
 * a default.
 *
 * The one thing that overrides it is whether the deployment can actually
 * support it. On an instance whose homeserver clients cannot reach, or which
 * doesn't record what its homeserver pushes, there is nowhere for a member's
 * keys to live except the server — so encrypting there would produce a channel
 * nobody can read while claiming the opposite. Those instances get plaintext
 * rooms and an `e2ee` capability that says so, which is the same capability
 * contract every other feature here uses.
 *
 * Encryption is applied *after* the room exists rather than at creation, so a
 * homeserver that refuses the state event leaves a working plaintext channel
 * and an honest `encrypted: false` in the index, instead of a half-made room.
 */
export async function createChannelRoom(
  accessToken: string,
  spaceId: string,
  name: string,
  description?: string
): Promise<{ roomId: string; encrypted: boolean }> {
  const roomId = await matrix.createChannelRoom(
    accessToken,
    spaceId,
    name,
    description
  );

  if (!e2eeAvailable()) return { roomId, encrypted: false };

  try {
    await matrix.enableRoomEncryption(accessToken, roomId);
    return { roomId, encrypted: true };
  } catch (err) {
    // Reported as unencrypted, which is what it is. The alternative — marking
    // it encrypted and hoping — is how a channel ends up with a lock icon over
    // plaintext, and this codebase has made that class of mistake twice.
    console.warn(`[matrix] channel ${roomId} created without encryption:`, err);
    return { roomId, encrypted: false };
  }
}

/**
 * Bridge between SOVRGNnet users and their Matrix accounts.
 * Provisions on first use; credentials live only in our database.
 */
export async function ensureMatrixCredentials(user: {
  id: number;
  username: string;
}): Promise<matrix.MatrixCredentials> {
  const existing = await db.getMatrixCredentials(user.id);
  if (existing) return existing;

  try {
    // Takes the account rather than an id, because provisioning now needs the
    // username as well. An object also means a caller can't quietly transpose
    // two arguments that are both about the same person and both typecheck.
    const creds = await matrix.registerOrLogin(user);
    await db.saveMatrixCredentials(user.id, creds.userId, creds.accessToken);
    return creds;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Matrix provisioning failed";
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `Messaging backend unavailable: ${message}`,
    });
  }
}

/**
 * Put a user into a community's rooms.
 *
 * The Space is invite-only, so this invites and then joins. The invite runs as
 * the community owner because it needs the invite power level and the person
 * joining has none — by design. SOVRGN decides who may join, through its own
 * join policy, invite codes and bans; this is how that decision reaches Matrix.
 *
 * Channel rooms use a restricted join rule keyed on Space membership, so once
 * someone is in the Space they can join channels without a separate invite.
 *
 * The inviter is optional so this still works for communities created before
 * the rooms became invite-only: those Spaces are still publicly joinable and a
 * plain join succeeds.
 */
export async function joinServerRooms(
  accessToken: string,
  spaceRoomId: string,
  channelRoomIds: string[],
  invite?: { ownerAccessToken: string; joiningMatrixUserId: string } | null
): Promise<void> {
  if (invite) {
    try {
      await matrix.inviteToRoom(
        invite.ownerAccessToken,
        spaceRoomId,
        invite.joiningMatrixUserId
      );
    } catch {
      // Already invited, already a member, or an older public Space that needs
      // no invite at all. The join below is what actually decides.
    }
  }

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
      await matrix.setPowerLevel(
        creds.accessToken,
        roomId,
        targetMatrixId,
        level
      );
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
        await matrix.kickUser(
          creds.accessToken,
          roomId,
          targetMatrixId,
          reason
        );
      }
    } catch {
      // The app-side membership row is authoritative for our own UI.
    }
  }
}
