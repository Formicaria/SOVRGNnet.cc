import { TRPCError } from "@trpc/server";
import * as db from "./db";

/**
 * Who can do what inside a server.
 *
 * Roles are ranked, not enumerated at each call site: "moderator or above"
 * is the useful question, and asking it in one place keeps the answer
 * consistent across every procedure.
 *
 * This is the authoritative check. Matrix power levels are kept in sync as a
 * mirror — so third-party Matrix clients behave sensibly — but the app never
 * trusts the homeserver's opinion about authority over its own.
 */
export type ServerRole = "owner" | "admin" | "moderator" | "member";

const RANK: Record<ServerRole, number> = {
  owner: 4,
  admin: 3,
  moderator: 2,
  member: 1,
};

export function atLeast(role: ServerRole, minimum: ServerRole): boolean {
  return RANK[role] >= RANK[minimum];
}

/** The user's role in a server, or null if they aren't a member. */
export async function getServerRole(
  serverId: number,
  userId: number
): Promise<ServerRole | null> {
  const server = await db.getServerById(serverId);
  if (!server) return null;
  // The owner column is the source of truth for ownership; the membership
  // row can lag behind (or be missing entirely on legacy servers).
  if (server.ownerId === userId) return "owner";
  return await db.getServerMemberRole(serverId, userId);
}

/**
 * Assert the user holds at least `minimum` in this server.
 * Returns their actual role so callers can branch further without a re-query.
 */
export async function requireServerRole(
  serverId: number,
  userId: number,
  minimum: ServerRole
): Promise<ServerRole> {
  const role = await getServerRole(serverId, userId);

  if (!role) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You are not a member of this server.",
    });
  }

  if (!atLeast(role, minimum)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        minimum === "owner"
          ? "Only the server owner can do that."
          : `You need to be a ${minimum} or above to do that.`,
    });
  }

  return role;
}

/**
 * Moderation guard: you may only act on someone strictly below you.
 *
 * Without the strictness, two admins could kick each other in a loop, and a
 * moderator could demote the person who promoted them.
 */
export async function requireAuthorityOver(
  serverId: number,
  actorId: number,
  targetId: number
): Promise<{ actorRole: ServerRole; targetRole: ServerRole }> {
  if (actorId === targetId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "You can't do that to yourself.",
    });
  }

  const actorRole = await requireServerRole(serverId, actorId, "moderator");
  const targetRole = await getServerRole(serverId, targetId);

  if (!targetRole) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "That person isn't a member of this server.",
    });
  }

  if (RANK[actorRole] <= RANK[targetRole]) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You can only moderate people ranked below you.",
    });
  }

  return { actorRole, targetRole };
}
