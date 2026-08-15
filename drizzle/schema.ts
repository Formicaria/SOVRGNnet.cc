import { integer, pgEnum, pgTable, text, timestamp, varchar, boolean, json, bigint, serial } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Define enums at module level
export const roleEnum = pgEnum("role", ["user", "admin"]);
export const channelTypeEnum = pgEnum("channel_type", ["text", "voice", "video"]);
export const nitroTierEnum = pgEnum("nitro_tier", ["basic", "pro", "ultra"]);
export const serverMemberRoleEnum = pgEnum("server_member_role", ["owner", "admin", "moderator", "member"]);

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = pgTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: serial("id").primaryKey(),
  /** User identifier (openId) from authentication provider. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }).unique(),
  /** scrypt hash for first-party email/password accounts. Null for external identities. */
  passwordHash: text("passwordHash"),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: roleEnum("role").default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// User Profiles (Extended)
export const userProfiles = pgTable("userProfiles", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  walletAddress: varchar("walletAddress", { length: 255 }).unique(),
  ensName: varchar("ensName", { length: 255 }),
  avatar: text("avatar"), // IPFS hash or URL
  bio: text("bio"),
  matrixUserId: varchar("matrixUserId", { length: 255 }).unique(),
  /** Server-held Matrix access token — the browser never sees this. */
  matrixAccessToken: text("matrixAccessToken"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;

// Servers (Matrix Spaces)
export const servers = pgTable("servers", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  matrixRoomId: varchar("matrixRoomId", { length: 255 }).notNull().unique(),
  ownerId: integer("ownerId").notNull(),
  icon: text("icon"), // IPFS hash or URL
  isPublic: boolean("isPublic").default(true).notNull(),
  /** Shareable invite code (nanoid). Null until the owner creates one. */
  inviteCode: varchar("inviteCode", { length: 32 }).unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type Server = typeof servers.$inferSelect;
export type InsertServer = typeof servers.$inferInsert;

// Channels (Matrix Rooms)
export const channels = pgTable("channels", {
  id: serial("id").primaryKey(),
  serverId: integer("serverId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  matrixRoomId: varchar("matrixRoomId", { length: 255 }).notNull().unique(),
  type: channelTypeEnum("type").default("text").notNull(),
  isPrivate: boolean("isPrivate").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type Channel = typeof channels.$inferSelect;
export type InsertChannel = typeof channels.$inferInsert;

// Messages
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  channelId: integer("channelId").notNull(),
  userId: integer("userId").notNull(),
  content: text("content").notNull(),
  matrixEventId: varchar("matrixEventId", { length: 255 }).notNull().unique(),
  encrypted: boolean("encrypted").default(true).notNull(),
  /** { "👍": [userId, ...] } — see db.toggleMessageReaction */
  reactions: json("reactions"),
  /** Set the first time a message is edited; null means never edited. */
  editedAt: timestamp("editedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

// File Shares
export const fileShares = pgTable("fileShares", {
  id: serial("id").primaryKey(),
  channelId: integer("channelId").notNull(),
  userId: integer("userId").notNull(),
  filename: varchar("filename", { length: 255 }).notNull(),
  ipfsHash: varchar("ipfsHash", { length: 255 }).notNull(),
  fileSize: bigint("fileSize", { mode: "number" }).notNull(),
  mimeType: varchar("mimeType", { length: 100 }),
  torrentMagnetLink: text("torrentMagnetLink"), // For WebTorrent
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type FileShare = typeof fileShares.$inferSelect;
export type InsertFileShare = typeof fileShares.$inferInsert;

// Soundboard Clips
export const soundboardClips = pgTable("soundboardClips", {
  id: serial("id").primaryKey(),
  serverId: integer("serverId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  ipfsHash: varchar("ipfsHash", { length: 255 }).notNull(),
  duration: integer("duration").notNull(), // milliseconds
  uploadedBy: integer("uploadedBy").notNull(),
  isNitroOnly: boolean("isNitroOnly").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SoundboardClip = typeof soundboardClips.$inferSelect;
export type InsertSoundboardClip = typeof soundboardClips.$inferInsert;

// NFT Nitro Subscriptions
export const nitroSubscriptions = pgTable("nitroSubscriptions", {
  id: serial("id").primaryKey(),
  userId: integer("userId").notNull(),
  walletAddress: varchar("walletAddress", { length: 255 }).notNull(),
  nftContractAddress: varchar("nftContractAddress", { length: 255 }).notNull(),
  nftTokenId: varchar("nftTokenId", { length: 255 }).notNull(),
  expiresAt: timestamp("expiresAt"),
  tier: nitroTierEnum("tier").default("basic").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type NitroSubscription = typeof nitroSubscriptions.$inferSelect;
export type InsertNitroSubscription = typeof nitroSubscriptions.$inferInsert;

// Server Members
export const serverMembers = pgTable("serverMembers", {
  id: serial("id").primaryKey(),
  serverId: integer("serverId").notNull(),
  userId: integer("userId").notNull(),
  role: serverMemberRoleEnum("role").default("member").notNull(),
  joinedAt: timestamp("joinedAt").defaultNow().notNull(),
});

export type ServerMember = typeof serverMembers.$inferSelect;
export type InsertServerMember = typeof serverMembers.$inferInsert;

/**
 * Server bans.
 *
 * A kick removes the membership row; a ban also records the person here so
 * they can't simply walk back in through discovery or an invite link.
 * Matrix-level bans block the rooms; this blocks the app.
 */
export const serverBans = pgTable("serverBans", {
  id: serial("id").primaryKey(),
  serverId: integer("serverId").notNull(),
  userId: integer("userId").notNull(),
  bannedBy: integer("bannedBy").notNull(),
  reason: text("reason"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type ServerBan = typeof serverBans.$inferSelect;
export type InsertServerBan = typeof serverBans.$inferInsert;

/**
 * Instance-wide settings, editable by an administrator from the client.
 *
 * These used to be environment variables, which meant reconfiguring an
 * instance required SSH and a restart. A server owner should be able to rename
 * their instance or close registration from the app they already have open.
 *
 * Exactly one row, id = 1. Environment variables remain the bootstrap
 * defaults for a fresh install; once a row exists it wins.
 */
export const instanceSettings = pgTable("instanceSettings", {
  id: integer("id").primaryKey().default(1),
  name: varchar("name", { length: 120 }),
  description: text("description"),
  /** open = anyone may register · invite = invite required · closed = nobody */
  joinPolicy: varchar("joinPolicy", { length: 16 }).default("invite").notNull(),
  /** Whether to appear in the sovrgnnet.cc directory. Opt-in, always. */
  listed: boolean("listed").default(false).notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type InstanceSettings = typeof instanceSettings.$inferSelect;
export type InsertInstanceSettings = typeof instanceSettings.$inferInsert;

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  profiles: many(userProfiles),
  servers: many(servers),
  subscriptions: many(nitroSubscriptions),
  messages: many(messages),
}));

export const userProfilesRelations = relations(userProfiles, ({ one }) => ({
  user: one(users, { fields: [userProfiles.userId], references: [users.id] }),
}));

export const serversRelations = relations(servers, ({ many, one }) => ({
  owner: one(users, { fields: [servers.ownerId], references: [users.id] }),
  channels: many(channels),
  members: many(serverMembers),
  soundboardClips: many(soundboardClips),
}));

export const channelsRelations = relations(channels, ({ many, one }) => ({
  server: one(servers, { fields: [channels.serverId], references: [servers.id] }),
  messages: many(messages),
  fileShares: many(fileShares),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  channel: one(channels, { fields: [messages.channelId], references: [channels.id] }),
  user: one(users, { fields: [messages.userId], references: [users.id] }),
}));

export const fileSharesRelations = relations(fileShares, ({ one }) => ({
  channel: one(channels, { fields: [fileShares.channelId], references: [channels.id] }),
  user: one(users, { fields: [fileShares.userId], references: [users.id] }),
}));

export const soundboardClipsRelations = relations(soundboardClips, ({ one }) => ({
  server: one(servers, { fields: [soundboardClips.serverId], references: [servers.id] }),
  uploadedByUser: one(users, { fields: [soundboardClips.uploadedBy], references: [users.id] }),
}));

export const nitroSubscriptionsRelations = relations(nitroSubscriptions, ({ one }) => ({
  user: one(users, { fields: [nitroSubscriptions.userId], references: [users.id] }),
}));

export const serverMembersRelations = relations(serverMembers, ({ one }) => ({
  server: one(servers, { fields: [serverMembers.serverId], references: [servers.id] }),
  user: one(users, { fields: [serverMembers.userId], references: [users.id] }),
}));
