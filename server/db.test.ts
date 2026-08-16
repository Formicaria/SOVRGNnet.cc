import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import * as db from "./db";

// Mock the database module
vi.mock("./db", async () => {
  const actual = await vi.importActual("./db");
  return actual;
});

// Integration tests — require a live Postgres (DATABASE_URL). CI provides one;
// locally run `docker compose up db` or they are skipped.
describe.skipIf(!process.env.DATABASE_URL)("Database Functions", () => {
  /**
   * This file used to write a userProfiles row for a hard-coded userId 1.
   *
   * routers.test.ts creates its own users, and in a throwaway database its
   * first user *is* id 1 — so both files were writing the same row while
   * vitest ran them in parallel. The symptom was routers.test.ts failing on a
   * userProfiles update, intermittently, depending on scheduling: this file
   * sets matrixUserId without an access token, so getMatrixCredentials read
   * the row as "no credentials" and re-provisioned into a row the other file
   * was already touching.
   *
   * Owning a user of its own removes the collision, and removes this file's
   * hidden assumption that some user 1 already exists.
   */
  let userId: number;

  beforeAll(async () => {
    const user = await db.createLocalUser(`dbtest_${Date.now()}@test.cc`, "x", "DB Test");
    userId = user.id;
  });

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
        1
      );
      expect(result).toBeDefined();
    });

    it("should retrieve soundboard clips by server ID", async () => {
      const clips = await db.getSoundboardClipsByServer(1);
      expect(Array.isArray(clips)).toBe(true);
    });
  });

  describe("User profile operations", () => {
    it("should create or update a user profile", async () => {
      const result = await db.createOrUpdateUserProfile(
        userId,
        // Unique per run: walletAddress carries a unique constraint too.
        `0x${Date.now().toString(16)}${"0".repeat(8)}`,
        "alice.eth",
        "ipfs://avatar",
        "Hello, I'm Alice",
        `@dbtest_${Date.now()}:matrix.org`
      );
      expect(result).toBeDefined();
    });

    it("should retrieve a user profile by ID", async () => {
      const profile = await db.getUserProfile(userId);
      expect(profile).toBeDefined();
    });
  });

  describe("Server member operations", () => {
    it("should add a server member with required fields", async () => {
      const result = await db.addServerMember(1, userId, "admin");
      expect(result).toBeDefined();
    });

    it("should retrieve server members by server ID", async () => {
      const members = await db.getServerMembers(1);
      expect(Array.isArray(members)).toBe(true);
    });
  });
});
