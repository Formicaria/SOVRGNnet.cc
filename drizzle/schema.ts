import { integer, pgEnum, pgTable, text, timestamp, varchar, boolean, json, bigint, serial } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// Define enums at module level
export const roleEnum = pgEnum("role", ["user", "admin"]);
export const channelTypeEnum = pgEnum("channel_type", ["text", "voice", "video"]);
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
  /**
   * The account's identity. Chosen at registration, and what the Matrix
   * localpart derives from.
   *
   * Stored already normalised — lowercased and trimmed by `checkUsername`.
   * Callers store what that returned rather than what was typed; storing raw
   * input is how `Alice` and `alice` become two rows the unique constraint
   * never notices.
   *
   * Length matches `USERNAME_MAX_LENGTH` in shared/username.ts. Kept in step
   * by a test rather than an import, because drizzle-kit reads this file to
   * diff the schema and a computed length would leave the migration history
   * unable to explain itself.
   */
  username: varchar("username", { length: 32 }).notNull().unique(),
  /**
   * `foldUsername(username)` — the key uniqueness is actually enforced on.
   *
   * Separators removed and lookalike characters collapsed, so `alice.hart`,
   * `alice_hart` and `a1ice-hart` cannot all exist at once. A unique index on
   * `username` alone would hold all three happily, which is the impersonation
   * this exists to prevent. Derived, never typed, never displayed.
   */
  usernameFold: varchar("usernameFold", { length: 32 }).notNull().unique(),
  name: text("name"),
  /**
   * Optional. An account is identified by its username; an email address is
   * contact information the operator may not want to hold and the member may
   * not want to give. Nullable here, and not required to register.
   */
  email: varchar("email", { length: 320 }).unique(),
  /** scrypt hash for first-party email/password accounts. Null for external identities. */
  passwordHash: text("passwordHash"),
  loginMethod: varchar("loginMethod", { length: 64 }),
  /**
   * Subject claim from a sovrgnnet.cc identity token, for accounts signed in
   * through central SSO. Null for purely local accounts, which continue to
   * work and are what every instance's first administrator uses.
   */
  ssoSubject: varchar("ssoSubject", { length: 128 }).unique(),
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
  /**
   * True when the Matrix room carries m.room.encryption. Learned from the
   * appservice push when any client enables it; the API refuses to send
   * plaintext into such a room rather than quietly undermining it.
   */
  encrypted: boolean("encrypted").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
});

export type Channel = typeof channels.$inferSelect;
export type InsertChannel = typeof channels.$inferInsert;

// Messages
export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  channelId: integer("channelId").notNull(),
  /**
   * The local account, when the sender has one. Null for federated senders —
   * members of the same room whose accounts live on another homeserver
   * (ADR 0010). senderMatrixId identifies them either way.
   */
  userId: integer("userId"),
  /** The full Matrix id (@user:server) that authored the event. */
  senderMatrixId: varchar("senderMatrixId", { length: 255 }),
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
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type SoundboardClip = typeof soundboardClips.$inferSelect;
export type InsertSoundboardClip = typeof soundboardClips.$inferInsert;

// Server Members
export const serverMembers = pgTable("serverMembers", {
  id: serial("id").primaryKey(),
  serverId: integer("serverId").notNull(),
  userId: integer("userId").notNull(),
  role: serverMemberRoleEnum("role").default("member").notNull(),
  /**
   * Per-server profile, the way Discord does it: one identity, but you can be
   * "Zach" in one community and "chronus" in another. Null means fall back to
   * the account's global name and avatar.
   */
  nickname: varchar("nickname", { length: 80 }),
  avatar: text("avatar"),
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

export const serverMembersRelations = relations(serverMembers, ({ one }) => ({
  server: one(servers, { fields: [serverMembers.serverId], references: [servers.id] }),
  user: one(users, { fields: [serverMembers.userId], references: [users.id] }),
}));
