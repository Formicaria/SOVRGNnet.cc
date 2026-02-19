import { describe, it, expect } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function createAuthContext(userId: number = 1): TrpcContext {
  const user: AuthenticatedUser = {
    id: userId,
    openId: "test-user",
    email: "test@example.com",
    name: "Test User",
    loginMethod: "manus",
    role: "user",
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };

  return {
    user,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

describe("tRPC Routers", () => {
  describe("auth router", () => {
    it("should return current user with me query", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const user = await caller.auth.me();
      expect(user).toEqual(ctx.user);
    });

    it("should logout successfully", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.auth.logout();
      expect(result.success).toBe(true);
    });
  });

  describe("servers router", () => {
    it("should list servers for a user", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const servers = await caller.servers.list();
      expect(Array.isArray(servers)).toBe(true);
    });

    it("should create a new server", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const uniqueRoomId = `!test${Date.now()}:matrix.org`;
      const result = await caller.servers.create({
        name: "Test Server",
        description: "A test server",
        matrixRoomId: uniqueRoomId,
        icon: "ipfs://hash",
      });
      expect(result).toBeDefined();
    });

    it("should retrieve a server by ID", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const server = await caller.servers.getById({ serverId: 1 });
      expect(server).toBeDefined();
    });
  });

  describe("channels router", () => {
    it("should list channels by server", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const channels = await caller.channels.listByServer({ serverId: 1 });
      expect(Array.isArray(channels)).toBe(true);
    });

    it("should create a new channel", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const uniqueRoomId = `!general${Date.now()}:matrix.org`;
      const result = await caller.channels.create({
        serverId: 1,
        name: "general",
        description: "General discussion",
        matrixRoomId: uniqueRoomId,
        type: "text",
      });
      expect(result).toBeDefined();
    });

    it("should retrieve a channel by ID", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const channel = await caller.channels.getById({ channelId: 1 });
      expect(channel).toBeDefined();
    });
  });

  describe("messages router", () => {
    it("should list messages by channel", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const messages = await caller.messages.listByChannel({
        channelId: 1,
        limit: 50,
      });
      expect(Array.isArray(messages)).toBe(true);
    });

    it("should create a new message", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const uniqueEventId = `$event${Date.now()}:matrix.org`;
      const result = await caller.messages.create({
        channelId: 1,
        content: "Hello, world!",
        matrixEventId: uniqueEventId,
        encrypted: true,
      });
      expect(result).toBeDefined();
    });
  });

  describe("fileShares router", () => {
    it("should list file shares by channel", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const files = await caller.fileShares.listByChannel({ channelId: 1 });
      expect(Array.isArray(files)).toBe(true);
    });

    it("should create a new file share", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const uniqueHash = `QmHash${Date.now()}`;
      const result = await caller.fileShares.create({
        channelId: 1,
        filename: "test.pdf",
        ipfsHash: uniqueHash,
        fileSize: 1024000,
        mimeType: "application/pdf",
      });
      expect(result).toBeDefined();
    });
  });

  describe("soundboard router", () => {
    it("should list soundboard clips by server", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const clips = await caller.soundboard.listByServer({
        serverId: 1,
        includeNitroOnly: false,
      });
      expect(Array.isArray(clips)).toBe(true);
    });

    it("should create a new soundboard clip", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const uniqueHash = `QmSound${Date.now()}`;
      const result = await caller.soundboard.create({
        serverId: 1,
        name: "airhorn",
        ipfsHash: uniqueHash,
        duration: 2000,
        isNitroOnly: false,
      });
      expect(result).toBeDefined();
    });
  });

  describe("profile router", () => {
    it("should get user profile", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const profile = await caller.profile.get();
      expect(profile).toBeDefined();
    });

    it("should update user profile", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.profile.update({
        walletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
        ensName: "alice.eth",
        avatar: "ipfs://avatar",
        bio: "Hello, I'm Alice",
      });
      expect(result).toBeDefined();
    });
  });

  describe("nitro router", () => {
    it("should get nitro subscription", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const subscription = await caller.nitro.getSubscription();
      expect(subscription).toBeDefined();
    });

    it("should create nitro subscription", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const uniqueTokenId = `${Date.now()}`;
      const result = await caller.nitro.createSubscription({
        walletAddress: "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
        nftContractAddress: "0x1234567890123456789012345678901234567890",
        nftTokenId: uniqueTokenId,
        tier: "pro",
      });
      expect(result).toBeDefined();
    });
  });

  describe("serverMembers router", () => {
    it("should list server members", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const members = await caller.serverMembers.list({ serverId: 1 });
      expect(Array.isArray(members)).toBe(true);
    });

    it("should add server member", async () => {
      const ctx = createAuthContext();
      const caller = appRouter.createCaller(ctx);
      const result = await caller.serverMembers.add({
        serverId: 1,
        userId: 2,
        role: "member",
      });
      expect(result).toBeDefined();
    });
  });
});
