import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
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

    create: protectedProcedure
      .input(z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        matrixRoomId: z.string(),
        icon: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return await db.createServer(
          input.name,
          input.description,
          input.matrixRoomId,
          ctx.user.id,
          input.icon
        );
      }),

    getById: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ input }) => {
        return await db.getServerById(input.serverId);
      }),
  }),

  // Channel operations
  channels: router({
    listByServer: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ input }) => {
        return await db.getChannelsByServer(input.serverId);
      }),

    create: protectedProcedure
      .input(z.object({
        serverId: z.number(),
        name: z.string().min(1),
        description: z.string().optional(),
        matrixRoomId: z.string(),
        type: z.enum(['text', 'voice', 'video']).default('text'),
      }))
      .mutation(async ({ input }) => {
        return await db.createChannel(
          input.serverId,
          input.name,
          input.description,
          input.matrixRoomId,
          input.type
        );
      }),

    getById: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ input }) => {
        return await db.getChannelById(input.channelId);
      }),
  }),

  // Message operations
  messages: router({
    listByChannel: protectedProcedure
      .input(z.object({
        channelId: z.number(),
        limit: z.number().default(50),
      }))
      .query(async ({ input }) => {
        return await db.getMessagesByChannel(input.channelId, input.limit);
      }),

    create: protectedProcedure
      .input(z.object({
        channelId: z.number(),
        content: z.string().min(1),
        matrixEventId: z.string(),
        encrypted: z.boolean().default(true),
      }))
      .mutation(async ({ ctx, input }) => {
        return await db.createMessage(
          input.channelId,
          ctx.user.id,
          input.content,
          input.matrixEventId,
          input.encrypted
        );
      }),
  }),

  // File share operations
  fileShares: router({
    listByChannel: protectedProcedure
      .input(z.object({ channelId: z.number() }))
      .query(async ({ input }) => {
        return await db.getFileSharesByChannel(input.channelId);
      }),

    create: protectedProcedure
      .input(z.object({
        channelId: z.number(),
        filename: z.string(),
        ipfsHash: z.string(),
        fileSize: z.number(),
        mimeType: z.string().optional(),
        torrentMagnetLink: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        return await db.createFileShare(
          input.channelId,
          ctx.user.id,
          input.filename,
          input.ipfsHash,
          input.fileSize,
          input.mimeType,
          input.torrentMagnetLink
        );
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

  // Server members
  serverMembers: router({
    list: protectedProcedure
      .input(z.object({ serverId: z.number() }))
      .query(async ({ input }) => {
        return await db.getServerMembers(input.serverId);
      }),

    add: protectedProcedure
      .input(z.object({
        serverId: z.number(),
        userId: z.number(),
        role: z.enum(['owner', 'admin', 'moderator', 'member']).default('member'),
      }))
      .mutation(async ({ input }) => {
        return await db.addServerMember(input.serverId, input.userId, input.role);
      }),
  }),

  // Matrix operations (server-side proxy)
  matrix: router({
    createRoom: protectedProcedure
      .input(z.object({
        name: z.string().min(1),
        topic: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const response = await fetch('http://localhost:8008/_matrix/client/v3/createRoom', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: input.name,
              topic: input.topic,
              visibility: 'public',
            }),
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`Matrix API error: ${response.status} - ${error}`);
          }

          const data = await response.json();
          return { roomId: data.room_id };
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to create Matrix room';
          throw new Error(message);
        }
      }),
  }),
});

export type AppRouter = typeof appRouter;
