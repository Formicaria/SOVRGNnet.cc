import { COOKIE_NAME } from "@shared/const";
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
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { nanoid } from "nanoid";
import { z } from "zod";
import * as db from "./db";
import * as matrix from "./matrixService";
import {
  ensureMatrixCredentials,
  joinServerRooms,
  requireServerMembership,
} from "./matrixBridge";
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
      .input(credentialsInput.extend({ name: z.string().min(1).max(100).optional() }))
      .mutation(async ({ ctx, input }) => {
        const existing = await db.getUserByEmail(input.email);
        if (existing) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "An account with this email already exists.",
          });
        }

        const passwordHash = await hashPassword(input.password);
        const user = await db.createLocalUser(input.email, passwordHash, input.name);

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

    /** Owner creates (or returns the existing) shareable invite code. */
    createInvite: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerById(input.serverId);
        if (!server) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Server not found." });
        }
        if (server.ownerId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the server owner can create invites.",
          });
        }
        if (server.inviteCode) return { code: server.inviteCode };

        const code = nanoid(10);
        await db.setServerInviteCode(server.id, code);
        return { code };
      }),

    /** Join via invite code — works for private servers too. */
    joinByInvite: protectedProcedure
      .input(z.object({ code: z.string().min(1).max(32) }))
      .mutation(async ({ ctx, input }) => {
        const server = await db.getServerByInviteCode(input.code);
        if (!server) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Invalid invite." });
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
        if (server.ownerId !== ctx.user.id) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only the server owner can create channels.",
          });
        }

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

        // E2EE lands in a later phase; until then messages are plaintext.
        return await db.createMessage(
          input.channelId,
          ctx.user.id,
          input.content,
          eventId,
          false
        );
      }),

    /** Delete a message — author or server owner. Redacts on Matrix too. */
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
        const server = await db.getServerById(channel.serverId);
        const isAuthor = message.userId === ctx.user.id;
        const isOwner = server?.ownerId === ctx.user.id;
        if (!isAuthor && !isOwner) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You can only delete your own messages.",
          });
        }

        // Redact as the author when possible, else as the acting owner.
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

  // Server members (joining happens via servers.join)
  serverMembers: router({
    list: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ ctx, input }) => {
        await requireServerMembership(input.serverId, ctx.user.id);
        return await db.getServerMembers(input.serverId);
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
