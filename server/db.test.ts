import { describe, it, expect, beforeEach, vi } from "vitest";
import * as db from "./db";

// Mock the database module
vi.mock("./db", async () => {
  const actual = await vi.importActual("./db");
  return actual;
});

// Integration tests — require a live Postgres (DATABASE_URL). CI provides one;
// locally run `docker compose up db` or they are skipped.
describe.skipIf(!process.env.DATABASE_URL)("Database Functions", () => {
  describe("Server operations", () => {
    it("should create a server with required fields", async () => {
      const uniqueRoomId = `!testroom${Date.now()}:matrix.org`;
      const result = await db.createServer(
        "Test Server",
        "A test server",
        uniqueRoomId,
        1,
        "ipfs://hash"
      );
      expect(result).toBeDefined();
    });

    it("should retrieve servers by user ID", async () => {
      const servers = await db.getServersByUser(1);
      expect(Array.isArray(servers)).toBe(true);
    });

    it("should retrieve a server by ID", async () => {
      const server = await db.getServerById(1);
      expect(server).toBeDefined();
    });
  });

  describe("Channel operations", () => {
    it("should create a channel with required fields", async () => {
      const uniqueRoomId = `!channel${Date.now()}:matrix.org`;
      const result = await db.createChannel(
        1,
        "general",
        "General discussion",
        uniqueRoomId,
        "text"
      );
      expect(result).toBeDefined();
    });

    it("should retrieve channels by server ID", async () => {
      const channels = await db.getChannelsByServer(1);
      expect(Array.isArray(channels)).toBe(true);
    });

    it("should retrieve a channel by ID", async () => {
      const channel = await db.getChannelById(1);
      expect(channel).toBeDefined();
    });
  });

  describe("Message operations", () => {
    it("should create a message with required fields", async () => {
      const uniqueEventId = `$event${Date.now()}:matrix.org`;
      const result = await db.createMessage(
        1,
        1,
        "Hello, world!",
        uniqueEventId,
        true
      );
      expect(result).toBeDefined();
    });

    it("should retrieve messages by channel ID", async () => {
      const messages = await db.getMessagesByChannel(1, 50);
      expect(Array.isArray(messages)).toBe(true);
    });
  });

  describe("File share operations", () => {
    it("should create a file share with required fields", async () => {
      const uniqueHash = `QmHash${Date.now()}`;
      const result = await db.createFileShare(
        1,
        1,
        "test.pdf",
        uniqueHash,
        1024000,
        "application/pdf"
      );
      expect(result).toBeDefined();
    });

    it("should retrieve file shares by channel ID", async () => {
      const files = await db.getFileSharesByChannel(1);
      expect(Array.isArray(files)).toBe(true);
    });
  });

  describe("Soundboard operations", () => {
    it("should create a soundboard clip with required fields", async () => {
      const uniqueHash = `QmSound${Date.now()}`;
      const result = await db.createSoundboardClip(
        1,
        "airhorn",
        uniqueHash,
        2000,
        1,
        false
      );
      expect(result).toBeDefined();
    });

    it("should retrieve soundboard clips by server ID", async () => {
      const clips = await db.getSoundboardClipsByServer(1, false);
      expect(Array.isArray(clips)).toBe(true);
    });
  });

  describe("Nitro subscription operations", () => {
    it("should create a nitro subscription with required fields", async () => {
      const uniqueTokenId = `${Date.now()}`;
      const result = await db.createNitroSubscription(
        1,
        "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
        "0x1234567890123456789012345678901234567890",
        uniqueTokenId,
        "pro",
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      );
      expect(result).toBeDefined();
    });

    it("should retrieve nitro subscription by user ID", async () => {
      const subscription = await db.getNitroSubscriptionByUser(1);
      expect(subscription).toBeDefined();
    });
  });

  describe("User profile operations", () => {
    it("should create or update a user profile", async () => {
      const result = await db.createOrUpdateUserProfile(
        1,
        "0x742d35Cc6634C0532925a3b844Bc9e7595f42bE",
        "alice.eth",
        "ipfs://avatar",
        "Hello, I'm Alice",
        "@alice:matrix.org"
      );
      expect(result).toBeDefined();
    });

    it("should retrieve a user profile by ID", async () => {
      const profile = await db.getUserProfile(1);
      expect(profile).toBeDefined();
    });
  });

  describe("Server member operations", () => {
    it("should add a server member with required fields", async () => {
      const result = await db.addServerMember(1, 1, "admin");
      expect(result).toBeDefined();
    });

    it("should retrieve server members by server ID", async () => {
      const members = await db.getServerMembers(1);
      expect(Array.isArray(members)).toBe(true);
    });
  });
});
