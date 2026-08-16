import { boolean, integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

/**
 * The identity provider's own database, separate from any server's.
 *
 * It holds accounts and nothing else — no messages, no servers, no
 * memberships. That separation is deliberate: this service is already a
 * concentration of risk, and giving it visibility into which communities
 * someone belongs to would make it a far more attractive target than it has
 * to be.
 */

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  /**
   * The stable public identifier that becomes a token's `sub` claim.
   * Opaque and permanent — deliberately not the email, which people change.
   */
  subject: varchar("subject", { length: 64 }).notNull().unique(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  /**
   * Whether the address has been proven. Servers use this to decide whether
   * linking to an existing local account by email is safe — without it,
   * signing up with someone else's address would take over their account.
   */
  emailVerified: boolean("emailVerified").default(false).notNull(),
  passwordHash: text("passwordHash").notNull(),
  displayName: varchar("displayName", { length: 80 }),
  avatar: text("avatar"),
  /** Set when an account is disabled; tokens stop being issued for it. */
  suspendedAt: timestamp("suspendedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn"),
});

export type Account = typeof accounts.$inferSelect;

/**
 * One-time recovery codes, stored as hashes.
 *
 * A row per code rather than an array on the account, so consuming one is a
 * delete and can't accidentally rewrite the others.
 */
export const recoveryCodes = pgTable("recoveryCodes", {
  id: serial("id").primaryKey(),
  accountId: integer("accountId").notNull(),
  codeHash: varchar("codeHash", { length: 64 }).notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * Email verification and password reset links.
 *
 * Tokens are stored hashed for the same reason recovery codes are: a leak of
 * this table must not be a leak of working reset links.
 */
export const emailTokens = pgTable("emailTokens", {
  id: serial("id").primaryKey(),
  accountId: integer("accountId").notNull(),
  /** "verify" | "reset" */
  purpose: varchar("purpose", { length: 16 }).notNull(),
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  expiresAt: timestamp("expiresAt").notNull(),
  usedAt: timestamp("usedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * Sessions on sovrgnnet.cc itself — the thing that lets someone request a
 * token for a server without signing in again.
 *
 * Distinct from the identity tokens, which are minted per server, last five
 * minutes, and are never stored.
 */
export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  accountId: integer("accountId").notNull(),
  tokenHash: varchar("tokenHash", { length: 64 }).notNull().unique(),
  userAgent: text("userAgent"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
});

/**
 * Which servers an account has signed into.
 *
 * Kept only so someone can see and revoke their own access — "you signed in to
 * these four servers; forget that one." It records the instance id a token was
 * minted for, not what happened afterwards, because this service has no
 * business knowing that.
 */
export const grants = pgTable("grants", {
  id: serial("id").primaryKey(),
  accountId: integer("accountId").notNull(),
  instanceId: varchar("instanceId", { length: 64 }).notNull(),
  instanceName: varchar("instanceName", { length: 120 }),
  firstUsedAt: timestamp("firstUsedAt").defaultNow().notNull(),
  lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
  revokedAt: timestamp("revokedAt"),
});
