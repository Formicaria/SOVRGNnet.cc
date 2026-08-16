import { APP_VERSION, COOKIE_NAME } from "@shared/const";
import { inviteDeepLink, inviteUrl } from "@shared/invite";
import { TRPCError } from "@trpc/server";
import {
  checkLoginRateLimit,
  createSessionToken,
  hashPassword,
  resetLoginRateLimit,
  setSessionCookie,
  verifyPassword,
} from "./_core/auth";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { canRegister, instanceInfo, normalizeJoinPolicy } from "./instance";
import { nanoid } from "nanoid";
import { z } from "zod";
import * as db from "./db";
import * as matrix from "./matrixService";
import {
  ensureMatrixCredentials,
  joinServerRooms,
  removeFromServerRooms,
  requireServerMembership,
  syncPowerLevels,
} from "./matrixBridge";
import {
  atLeast,
  getServerRole,
  requireAuthorityOver,
  requireServerRole,
  type ServerRole,
} from "./permissions";
import * as presence from "./presence";
import type { User } from "../drizzle/schema";

const credentialsInput = z.object({
  email: z.string().email().max(320),
  password: z.string().min(8).max(256),
});

/** Public shape of a user — never expose passwordHash. */
function toPublicUser(user: User) {
  const { passwordHash: _passwordHash, ...publicUser } = user;
  return publicUser;
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(({ ctx }) =>
      ctx.user ? toPublicUser(ctx.user) : null
    ),

    register: publicProcedure
      .input(
        credentialsInput.extend({
          name: z.string().min(1).max(100).optional(),
          /** Carried from an invite link, for invite-only instances. */
          inviteCode: z.string().min(1).max(32).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const existing = await db.getUserByEmail(input.email);
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "An account with this email already exists.",
          });
        }

        // Whoever registers first is the person who set this instance up, so
        // they get the keys to it. Every account after that is an ordinary
        // user until an admin says otherwise. Without this nobody is ever an
        // admin and the instance has no administrator at all.
        const isFirstAccount = (await db.countUsers()) === 0;

        // The instance's join policy was advertised by /api/instance but never
        // actually enforced, so a server marked "closed" still accepted
        // anyone. It does now.
        const settings = await db.getInstanceSettings().catch(() => null);
        const policy = instanceInfo(APP_VERSION, settings).joinPolicy;
        const hasValidInvite = input.inviteCode
          ? (await db.getServerByInviteCode(input.inviteCode)) != null
          : false;

        const verdict = canRegister({ policy, isFirstAccount, hasValidInvite });
        if (!verdict.allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: verdict.message });
        }

        const passwordHash = await hashPassword(input.password);
        const user = await db.createLocalUser(
          input.email,
          passwordHash,
          input.name,
          isFirstAccount ? "admin" : "user"
        );

        const token = await createSessionToken(user.id);
        setSessionCookie(ctx.req, ctx.res, token);
        return toPublicUser(user);
      }),

    login: publicProcedure
      .input(credentialsInput)
      .mutation(async ({ ctx, input }) => {
        const rateKey = `${ctx.req.ip ?? "unknown"}:${input.email.toLowerCase()}`;
        if (!checkLoginRateLimit(rateKey)) {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "Too many login attempts. Try again in 15 minutes.",
          });
        }

        const user = await db.getUserByEmail(input.email);
        const valid =
          user?.passwordHash != null &&
          (await verifyPassword(input.password, user.passwordHash));

        if (!user || !valid) {
          throw new TRPCError({
            code: "UNAUTHORIZED",
            message: "Invalid email or password.",
          });
        }

        resetLoginRateLimit(rateKey);
        await db.touchLastSignedIn(user.id);

        const token = await createSessionToken(user.id);
        setSessionCookie(ctx.req, ctx.res, token);
        return toPublicUser(user);
      }),

    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // Server operations
  servers: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return await db.getServersByUser(ctx.user.id);
    }),

    listPublic: protectedProcedure.query(async () => {
      return await db.getPublicServers();
    }),

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        icon: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const creds = await ensureMatrixCredentials(ctx.user.id);

        const spaceId = await matrix.createSpace(
          creds.accessToken,
          input.name,
          input.description
        );
        const server = await db.createServer(
          input.name,
          input.description,
          spaceId,
          ctx.user.id,
          input.icon
        );
        await db.addServerMember(server.id, ctx.user.id, "owner");

        // Every server starts with a #general channel.
        const generalRoomId = await matrix.createChannelRoom(
          creds.accessToken,
          spaceId,
          "general"
        );
        const general = await db.createChannel(
          server.id,
          "general",
          undefined,
          generalRoomId,
          "text"
        );

        return { server, defaultChannel: general };
      }),

    join: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server || !server.isPublic) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Server not found." });
        }
        if (await db.isServerMember(server.id, ctx.user.id)) {
          return { joined: true } as const;
        }
        if (await db.isServerBanned(server.id, ctx.user.id)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You've been banned from this server.",
          });
        }

        const creds = await ensureMatrixCredentials(ctx.user.id);
        const channels = await db.getChannelsByServer(server.id);
        await joinServerRooms(
          creds.accessToken,
          server.matrixRoomId,
          channels.map(c => c.matrixRoomId)
        );
        await db.addServerMember(server.id, ctx.user.id, "member");
        return { joined: true } as const;
      }),

    getById: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        return await db.getServerById(input.serverId);
      }),

    /** Admins and up create (or return the existing) shareable invite code. */
    createInvite: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Server not found." });
        }
        await requireServerRole(input.serverId, ctx.user.id, "admin");

        let code = server.inviteCode;
        if (!code) {
          code = nanoid(10);
          await db.setServerInviteCode(server.id, code);
        }

        // The link has to name the server, not just the code — a client
        // connected to several servers can't resolve a bare code. Derived
        // from the Host header so it's correct behind a tunnel or proxy,
        // where the app has no reliable idea of its own public address.
        const host = String(ctx.req.headers["x-forwarded-host"] ?? ctx.req.headers.host ?? "");
        return {
          code,
          url: host ? inviteUrl(host, code) : null,
          deepLink: host ? inviteDeepLink(host, code) : null,
        };
      }),

    /** Join via invite code — works for private servers too. */
    joinByInvite: protectedProcedure
      .input(z.object({ code: z.string().min(1).max(32) }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerByInviteCode(input.code);
        if (!server) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Invalid invite." });
        }
        if (await db.isServerBanned(server.id, ctx.user.id)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You've been banned from this server.",
          });
        }
        if (!(await db.isServerMember(server.id, ctx.user.id))) {
          const creds = await ensureMatrixCredentials(ctx.user.id);
          const channels = await db.getChannelsByServer(server.id);
          await joinServerRooms(
            creds.accessToken,
            server.matrixRoomId,
            channels.map(c => c.matrixRoomId)
          );
          await db.addServerMember(server.id, ctx.user.id, "member");
        }
        return { serverId: server.id, serverName: server.name };
      }),

    /** Leave a server (owners can't leave their own). */
    leave: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Server not found." });
        }
        if (server.ownerId === ctx.user.id) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Owners cannot leave their own server.",
          });
        }

        const creds = await db.getMatrixCredentials(ctx.user.id);
        if (creds) {
          const channels = await db.getChannelsByServer(server.id);
          for (const roomId of [server.matrixRoomId, ...channels.map(c => c.matrixRoomId)]) {
            try {
              await matrix.leaveRoom(creds.accessToken, roomId);
            } catch {
              // Best-effort; membership removal below is authoritative.
            }
          }
        }
        await db.removeServerMember(server.id, ctx.user.id);
        return { left: true } as const;
      }),
  }),

  // Channel operations
  channels: router({
    listByServer: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        return await db.getChannelsByServer(input.serverId);
      }),

    create: protectedProcedure
      .input(z.object({
        serverId: z.number(),
        name: z.string().min(1).max(100),
        description: z.string().max(500).optional(),
        type: z.enum(['text', 'voice', 'video']).default('text'),
      }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Server not found." });
        }
        await requireServerRole(input.serverId, ctx.user.id, "admin");

        const creds = await ensureMatrixCredentials(ctx.user.id);
        const roomId = await matrix.createChannelRoom(
          creds.accessToken,
          server.matrixRoomId,
          input.name,
          input.description
        );
        return await db.createChannel(
          input.serverId,
          input.name,
          input.description,
          roomId,
          input.type
        );
      }),

    getById: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) return undefined;
        await requireServerMembership(channel.serverId, ctx.user.id);
        return channel;
      }),

    /** "I'm typing" — call while someone is composing. */
    setTyping: protectedProcedure
      .input(z.object({ channelId: z.number(), typing: z.boolean().default(true) }))
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        if (input.typing) {
          presence.noteTyping(input.channelId, ctx.user.id);
        } else {
          presence.clearTyping(input.channelId, ctx.user.id);
        }

        // Also tell Matrix, so people watching from Element see it too.
        const [creds, matrixUserId] = await Promise.all([
          db.getMatrixCredentials(ctx.user.id),
          db.getMatrixUserId(ctx.user.id),
        ]);
        if (creds && matrixUserId) {
          matrix
            .setTyping(creds.accessToken, channel.matrixRoomId, matrixUserId, input.typing)
            .catch(() => {
              // A lost typing notification is not worth surfacing.
            });
        }

        return { ok: true } as const;
      }),

    /** Names of everyone currently typing here, excluding you. */
    whoIsTyping: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) return [];
        await requireServerMembership(channel.serverId, ctx.user.id);

        // Reading the channel is a sign of life, so it doubles as a heartbeat.
        presence.noteActivity(ctx.user.id);

        const userIds = presence.getTypingUserIds(input.channelId, ctx.user.id);
        if (userIds.length === 0) return [];

        const members = await db.getServerMembersDetailed(channel.serverId);
        const nameById = new Map(members.map(m => [m.userId, m.name]));
        return userIds.map(id => ({ userId: id, name: nameById.get(id) ?? "Someone" }));
      }),
  }),

  // Message operations
  messages: router({
    listByChannel: protectedProcedure
      .input(z.object({
        channelId: z.number(),
        limit: z.number().min(1).max(200).default(50),
      }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);
        return await db.getMessagesByChannel(input.channelId, input.limit);
      }),

    send: protectedProcedure
      .input(z.object({
        channelId: z.number(),
        content: z.string().min(1).max(4000),
      }))
      .mutation(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        const creds = await ensureMatrixCredentials(ctx.user.id);
        const eventId = await matrix.sendMessage(
          creds.accessToken,
          channel.matrixRoomId,
          input.content
        );

        presence.clearTyping(input.channelId, ctx.user.id);

        // E2EE lands in a later phase; until then messages are plaintext.
        return await db.createMessage(
          input.channelId,
          ctx.user.id,
          input.content,
          eventId,
          false
        );
      }),

    /** Edit your own message. Moderators can't rewrite what others said. */
    edit: protectedProcedure
      .input(z.object({
        messageId: z.number(),
        content: z.string().min(1).max(4000),
      }))
      .mutation(async ({ ctx, input }) => {
        const message = await db.getMessageById(input.messageId);
        if (!message) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Message not found." });
        }
        if (message.userId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only edit your own messages.",
          });
        }

        const channel = await db.getChannelById(message.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        const creds = await db.getMatrixCredentials(ctx.user.id);
        if (creds) {
          try {
            await matrix.editMessage(
              creds.accessToken,
              channel.matrixRoomId,
              message.matrixEventId,
              input.content
            );
          } catch {
            // The homeserver keeps the original; our copy is what the app shows.
          }
        }

        return await db.updateMessageContent(message.id, input.content);
      }),

    /** Toggle one emoji reaction for the current user. */
    react: protectedProcedure
      .input(z.object({
        messageId: z.number(),
        // Emoji only — this is a reaction, not a second message body.
        emoji: z.string().min(1).max(16),
      }))
      .mutation(async ({ ctx, input }) => {
        const message = await db.getMessageById(input.messageId);
        if (!message) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Message not found." });
        }
        const channel = await db.getChannelById(message.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);

        const existing = (message.reactions as db.ReactionMap | null) ?? {};
        const wasReacted = (existing[input.emoji] ?? []).includes(ctx.user.id);

        const reactions = await db.toggleMessageReaction(
          message.id,
          ctx.user.id,
          input.emoji
        );

        // Matrix has no "unreact" beyond redacting the annotation event, and
        // we don't track annotation ids yet — so only additions propagate.
        if (!wasReacted) {
          const creds = await db.getMatrixCredentials(ctx.user.id);
          if (creds) {
            try {
              await matrix.sendReaction(
                creds.accessToken,
                channel.matrixRoomId,
                message.matrixEventId,
                input.emoji
              );
            } catch {
              // Cosmetic on the Matrix side; the app's copy is authoritative.
            }
          }
        }

        return reactions;
      }),

    /** Delete a message — the author, or a moderator and above. */
    delete: protectedProcedure
      .input(z.object({ messageId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const message = await db.getMessageById(input.messageId);
        if (!message) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Message not found." });
        }
        const channel = await db.getChannelById(message.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        const isAuthor = message.userId === ctx.user.id;
        const role = await getServerRole(channel.serverId, ctx.user.id);
        if (!role) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a member of this server.",
          });
        }
        if (!isAuthor && !atLeast(role, "moderator")) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only delete your own messages.",
          });
        }

        // Redact as the author when possible, else as the acting moderator.
        const creds = await db.getMatrixCredentials(
          isAuthor ? ctx.user.id : message.userId
        ) ?? await db.getMatrixCredentials(ctx.user.id);
        if (creds) {
          try {
            await matrix.redactEvent(
              creds.accessToken,
              channel.matrixRoomId,
              message.matrixEventId
            );
          } catch {
            // DB deletion below is authoritative for the app's view.
          }
        }
        await db.deleteMessage(message.id);
        return { deleted: true } as const;
      }),
  }),

  // File share metadata (uploads/downloads go through /api/upload and /api/files)
  fileShares: router({
    listByChannel: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ ctx, input }) => {
        const channel = await db.getChannelById(input.channelId);
        if (!channel) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
        }
        await requireServerMembership(channel.serverId, ctx.user.id);
        return await db.getFileSharesByChannel(input.channelId);
      }),
  }),

  // Soundboard operations
  soundboard: router({
    listByServer: protectedProcedure
      .input(z.object({
        serverId: z.number(),
        includeNitroOnly: z.boolean().default(false),
      }))
      .query(async ({ input }) => {
        return await db.getSoundboardClipsByServer(input.serverId, input.includeNitroOnly);
      }),

    create: protectedProcedure
      .input(z.object({
        serverId: z.number(),
        name: z.string(),
        ipfsHash: z.string(),
        duration: z.number(),
        isNitroOnly: z.boolean().default(false),
      }))
      .mutation(async ({ ctx, input }) => {
        return await db.createSoundboardClip(
          input.serverId,
          input.name,
          input.ipfsHash,
          input.duration,
          ctx.user.id,
          input.isNitroOnly
        );
      }),
  }),

  // User profile operations
  profile: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      return await db.getUserProfile(ctx.user.id);
    }),

    update: protectedProcedure
      .input(z.object({
        walletAddress: z.string().optional(),
        ensName: z.string().optional(),
        avatar: z.string().optional(),
        bio: z.string().optional(),
        matrixUserId: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return await db.createOrUpdateUserProfile(
          ctx.user.id,
          input.walletAddress,
          input.ensName,
          input.avatar,
          input.bio,
          input.matrixUserId
        );
      }),
  }),

  // Nitro subscription operations
  nitro: router({
    getSubscription: protectedProcedure.query(async ({ ctx }) => {
      return await db.getNitroSubscriptionByUser(ctx.user.id);
    }),

    createSubscription: protectedProcedure
      .input(z.object({
        walletAddress: z.string(),
        nftContractAddress: z.string(),
        nftTokenId: z.string(),
        tier: z.enum(['basic', 'pro', 'ultra']).default('basic'),
        expiresAt: z.date().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return await db.createNitroSubscription(
          ctx.user.id,
          input.walletAddress,
          input.nftContractAddress,
          input.nftTokenId,
          input.tier,
          input.expiresAt
        );
      }),
  }),

  // Server members (joining happens via servers.join / servers.joinByInvite)
  serverMembers: router({
    /** Everyone in the server, with role and whether they're around. */
    list: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        presence.noteActivity(ctx.user.id);

        const server = await db.getServerById(input.serverId);
        const members = await db.getServerMembersDetailed(input.serverId);

        // The owner may predate the membership table; make sure they appear.
        const rows = members.some(m => m.userId === server?.ownerId)
          ? members
          : server
            ? [
                {
                  userId: server.ownerId,
                  role: "owner" as const,
                  joinedAt: server.createdAt,
                  name: null as string | null,
                  email: null as string | null,
                  matrixUserId: null as string | null,
                },
                ...members,
              ]
            : members;

        const online = presence.onlineUserIds(rows.map(r => r.userId));
        const rank: Record<string, number> = { owner: 0, admin: 1, moderator: 2, member: 3 };

        return rows
          .map(r => ({
            userId: r.userId,
            name: r.name,
            role: r.userId === server?.ownerId ? ("owner" as const) : r.role,
            joinedAt: r.joinedAt,
            online: online.has(r.userId),
          }))
          .sort(
            (a, b) =>
              rank[a.role] - rank[b.role] ||
              (a.name ?? "").localeCompare(b.name ?? "")
          );
      }),

    /** Promote or demote. Only the owner hands out admin. */
    setRole: protectedProcedure
      .input(z.object({
        serverId: z.number(),
        userId: z.number(),
        role: z.enum(["admin", "moderator", "member"]),
      }))
      .mutation(async ({ ctx, input }) => {
        const { actorRole } = await requireAuthorityOver(
          input.serverId,
          ctx.user.id,
          input.userId
        );

        // You can't hand out authority at or above your own.
        const granting: ServerRole = input.role;
        const rankOf: Record<ServerRole, number> = {
          owner: 4, admin: 3, moderator: 2, member: 1,
        };
        if (rankOf[granting] >= rankOf[actorRole]) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can't grant a role equal to or above your own.",
          });
        }

        await db.setServerMemberRole(input.serverId, input.userId, input.role);
        await syncPowerLevels(
          input.serverId,
          ctx.user.id,
          input.userId,
          matrix.POWER_LEVELS[input.role]
        );

        return { role: input.role } as const;
      }),

    /** Remove someone. They can come back through discovery or an invite. */
    kick: protectedProcedure
      .input(z.object({ serverId: z.number(), userId: z.number(), reason: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireAuthorityOver(input.serverId, ctx.user.id, input.userId);
        await removeFromServerRooms(
          input.serverId,
          ctx.user.id,
          input.userId,
          "kick",
          input.reason
        );
        await db.removeServerMember(input.serverId, input.userId);
        return { kicked: true } as const;
      }),

    /** Remove someone and keep them out. */
    ban: protectedProcedure
      .input(z.object({ serverId: z.number(), userId: z.number(), reason: z.string().max(500).optional() }))
      .mutation(async ({ ctx, input }) => {
        await requireAuthorityOver(input.serverId, ctx.user.id, input.userId);
        await removeFromServerRooms(
          input.serverId,
          ctx.user.id,
          input.userId,
          "ban",
          input.reason
        );
        await db.removeServerMember(input.serverId, input.userId);
        await db.banServerMember(
          input.serverId,
          input.userId,
          ctx.user.id,
          input.reason
        );
        return { banned: true } as const;
      }),

    unban: protectedProcedure
      .input(z.object({ serverId: z.number(), userId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        await requireServerRole(input.serverId, ctx.user.id, "moderator");
        await db.unbanServerMember(input.serverId, input.userId);
        return { unbanned: true } as const;
      }),

    listBans: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerRole(input.serverId, ctx.user.id, "moderator");
        return await db.getServerBans(input.serverId);
      }),

    /** Your own role here — the client uses this to decide what to show. */
    myRole: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        return await getServerRole(input.serverId, ctx.user.id);
      }),
  }),

  /**
   * Instance administration.
   *
   * Everything a server owner would otherwise SSH in to change. Restricted to
   * accounts with the instance-level admin role — which is the first account
   * registered, and anyone they promote.
   *
   * Works the same whether the client is on the same machine as the server or
   * across the internet: administering a box in your closet from the laptop
   * in your hand is the point, not a special case.
   */
  admin: router({
    getSettings: adminProcedure.query(async () => {
      const stored = await db.getInstanceSettings();
      const info = instanceInfo(APP_VERSION, stored);
      return {
        name: info.name,
        description: info.description,
        joinPolicy: info.joinPolicy,
        listed: info.listed,
        // Read-only facts an admin needs to see but cannot change here:
        // the Matrix name is permanent, and encryption depends on deployment.
        matrixServerName: info.matrixServerName,
        encryption: info.encryption,
        instanceId: info.id,
        version: info.software.version,
        /** True once an admin has saved anything; false means env defaults. */
        configured: stored != null,
      };
    }),

    updateSettings: adminProcedure
      .input(
        z.object({
          name: z.string().min(1).max(120).optional(),
          description: z.string().max(500).nullable().optional(),
          joinPolicy: z.enum(["open", "invite", "closed"]).optional(),
          listed: z.boolean().optional(),
        })
      )
      .mutation(async ({ input }) => {
        const saved = await db.saveInstanceSettings(input);
        return {
          name: saved.name,
          description: saved.description,
          joinPolicy: normalizeJoinPolicy(saved.joinPolicy),
          listed: saved.listed,
        };
      }),

    /** Everyone with an account on this instance. */
    listUsers: adminProcedure.query(async () => {
      return await db.listUsers();
    }),

    /** Grant or revoke instance administration. */
    setUserRole: adminProcedure
      .input(z.object({ userId: z.number(), role: z.enum(["user", "admin"]) }))
      .mutation(async ({ ctx, input }) => {
        if (input.userId === ctx.user.id && input.role === "user") {
          // An instance with no administrator can only be repaired from a
          // database console, which is exactly what this surface exists to
          // avoid needing.
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "You can't remove your own admin access.",
          });
        }
        await db.setUserRole(input.userId, input.role);
        return { role: input.role } as const;
      }),
  }),

  // Matrix status (everything else goes through servers/channels/messages)
  matrix: router({
    status: publicProcedure.query(async () => ({
      reachable: await matrix.isHomeserverReachable(),
    })),
  }),
});

export type AppRouter = typeof appRouter;
