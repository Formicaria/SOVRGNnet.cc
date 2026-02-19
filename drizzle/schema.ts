import { int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, json, bigint } from "drizzle-orm/mysql-core";
import { relations } from "drizzle-orm";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// User Profiles (Extended)
export const userProfiles = mysqlTable("userProfiles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  walletAddress: varchar("walletAddress", { length: 255 }).unique(),
  ensName: varchar("ensName", { length: 255 }),
  avatar: text("avatar"), // IPFS hash or URL
  bio: text("bio"),
  matrixUserId: varchar("matrixUserId", { length: 255 }).unique(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type UserProfile = typeof userProfiles.$inferSelect;
export type InsertUserProfile = typeof userProfiles.$inferInsert;

// Servers (Matrix Spaces)
export const servers = mysqlTable("servers", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  matrixRoomId: varchar("matrixRoomId", { length: 255 }).notNull().unique(),
  ownerId: int("ownerId").notNull(),
  icon: text("icon"), // IPFS hash or URL
  isPublic: boolean("isPublic").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Server = typeof servers.$inferSelect;
export type InsertServer = typeof servers.$inferInsert;

// Channels (Matrix Rooms)
export const channels = mysqlTable("channels", {
  id: int("id").autoincrement().primaryKey(),
  serverId: int("serverId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  matrixRoomId: varchar("matrixRoomId", { length: 255 }).notNull().unique(),
  type: mysqlEnum("type", ["text", "voice", "video"]).default("text").notNull(),
  isPrivate: boolean("isPrivate").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Channel = typeof channels.$inferSelect;
export type InsertChannel = typeof channels.$inferInsert;

// Messages
export const messages = mysqlTable("messages", {
  id: int("id").autoincrement().primaryKey(),
  channelId: int("channelId").notNull(),
  userId: int("userId").notNull(),
  content: text("content").notNull(),
  matrixEventId: varchar("matrixEventId", { length: 255 }).notNull().unique(),
  encrypted: boolean("encrypted").default(true).notNull(),
  reactions: json("reactions"), // JSON object of emoji -> user list
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = typeof messages.$inferInsert;

// File Shares
export const fileShares = mysqlTable("fileShares", {
  id: int("id").autoincrement().primaryKey(),
  channelId: int("channelId").notNull(),
  userId: int("userId").notNull(),
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
export const soundboardClips = mysqlTable("soundboardClips", {
  id: int("id").autoincrement().primaryKey(),
  serverId: int("serverId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  ipfsHash: varchar("ipfsHash", { length: 255 }).notNull(),
  duration: int("duration").notNull(), // milliseconds
  uploadedBy: int("uploadedBy").notNull(),
  isNitroOnly: boolean("isNitroOnly").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SoundboardClip = typeof soundboardClips.$inferSelect;
export type InsertSoundboardClip = typeof soundboardClips.$inferInsert;

// NFT Nitro Subscriptions
export const nitroSubscriptions = mysqlTable("nitroSubscriptions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  walletAddress: varchar("walletAddress", { length: 255 }).notNull(),
  nftContractAddress: varchar("nftContractAddress", { length: 255 }).notNull(),
  nftTokenId: varchar("nftTokenId", { length: 255 }).notNull(),
  expiresAt: timestamp("expiresAt"),
  tier: mysqlEnum("tier", ["basic", "pro", "ultra"]).default("basic").notNull(),
  isActive: boolean("isActive").default(true).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type NitroSubscription = typeof nitroSubscriptions.$inferSelect;
export type InsertNitroSubscription = typeof nitroSubscriptions.$inferInsert;

// Server Members
export const serverMembers = mysqlTable("serverMembers", {
  id: int("id").autoincrement().primaryKey(),
  serverId: int("serverId").notNull(),
  userId: int("userId").notNull(),
  role: mysqlEnum("role", ["owner", "admin", "moderator", "member"]).default("member").notNull(),
  joinedAt: timestamp("joinedAt").defaultNow().notNull(),
});

export type ServerMember = typeof serverMembers.$inferSelect;
export type InsertServerMember = typeof serverMembers.$inferInsert;

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
