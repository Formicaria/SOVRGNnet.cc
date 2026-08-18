import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

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
  /**
   * Optional now that most people arrive through Google, Microsoft, GitHub,
   * or Discord. Null means this account signs in only through a provider.
   *
   * Still supported deliberately: it's the fallback for anyone who wants no
   * third party involved, and the insurance for anyone locked out by one.
   */
  passwordHash: text("passwordHash"),
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
 * "This Google account is this person."
 *
 * The whole reason the provider can be a broker rather than a password store:
 * what's held here is a mapping, not a credential. A leak of this table
 * reveals which third-party accounts belong to which subject — not pleasant,
 * but it lets nobody sign in as anybody.
 *
 * Several rows may point at one account, and that matters: linking a second
 * provider is what stops a Google suspension costing someone every SOVRGNnet
 * server at once.
 */
export const identities = pgTable(
  "identities",
  {
    id: serial("id").primaryKey(),
    accountId: integer("accountId").notNull(),
    /** "google" | "microsoft" | "github" | "discord" */
    provider: varchar("provider", { length: 32 }).notNull(),
    /** The provider's permanent id for them. Never an email — those move. */
    providerUserId: varchar("providerUserId", { length: 128 }).notNull(),
    /** The address as the provider gave it, for display and support. */
    email: varchar("email", { length: 320 }),
    emailVerified: boolean("emailVerified").default(false).notNull(),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
    lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
  },
  table => ({
    // One provider identity can belong to exactly one account. Without this,
    // a race could attach the same Google account to two subjects and make
    // "who are you" ambiguous forever.
    providerIdentity: unique("identities_provider_user").on(
      table.provider,
      table.providerUserId
    ),
  })
);

export type Identity = typeof identities.$inferSelect;

/**
 * In-flight OAuth attempts.
 *
 * Holds the `state` that ties a callback back to the request that started it —
 * without which a callback from anywhere could be replayed — plus the PKCE
 * verifier and where to return afterwards. Rows are short-lived and deleted
 * on use.
 */
export const oauthAttempts = pgTable("oauthAttempts", {
  id: serial("id").primaryKey(),
  state: varchar("state", { length: 64 }).notNull().unique(),
  provider: varchar("provider", { length: 32 }).notNull(),
  codeVerifier: varchar("codeVerifier", { length: 128 }),
  /** Where to send them once signed in — validated before it's stored. */
  returnUrl: text("returnUrl"),
  /** Set when an already-signed-in person is adding a second provider. */
  linkToAccountId: integer("linkToAccountId"),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

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
/**
 * In-flight desktop sign-ins.
 *
 * The desktop app can't use the browser redirect flow — returning a token to
 * `sovrgn://` would hand it to whatever application registered that scheme.
 * So it asks for a code here, the person approves it in their own browser,
 * and the app polls this table.
 *
 * The device code is stored hashed: it's the bearer secret the app polls with,
 * and a leak of this table shouldn't hand anyone a pending sign-in.
 */
export const deviceAuthorizations = pgTable("deviceAuthorizations", {
  id: serial("id").primaryKey(),
  deviceCodeHash: varchar("deviceCodeHash", { length: 64 }).notNull().unique(),
  /** The short code a person reads off the app and types in a browser. */
  userCode: varchar("userCode", { length: 16 }).notNull().unique(),
  /** Set once somebody signed in approves it. */
  accountId: integer("accountId"),
  /** "pending" | "approved" | "denied" */
  status: varchar("status", { length: 16 }).default("pending").notNull(),
  /** Handed to the app once approved, then never again. */
  sessionTokenHash: varchar("sessionTokenHash", { length: 64 }),
  /** Bumped when polled too fast, so the server can ask it to back off. */
  polls: integer("polls").default(0).notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  lastPolledAt: timestamp("lastPolledAt"),
});

/**
 * One-time codes that carry a signed-in person from the id host to the hub
 * on its own hostname.
 *
 * Cookies are per-host, so a session on the id origin is invisible to the hub
 * origin even though one process serves both. The alternatives were worse:
 * widening the cookie to `Domain=.sovrgnnet.cc` hands the session to every
 * subdomain forever, and cross-origin credentials would mean CSRF machinery
 * on a service that currently needs none. So the id host mints a code here
 * and the hub host redeems it for its own session — hashed at rest, sixty
 * seconds to live, deleted on use: the device-flow discipline, first-party.
 */
export const hubHandoffs = pgTable("hubHandoffs", {
  id: serial("id").primaryKey(),
  codeHash: varchar("codeHash", { length: 64 }).notNull().unique(),
  accountId: integer("accountId").notNull(),
  expiresAt: timestamp("expiresAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export const grants = pgTable("grants", {
  id: serial("id").primaryKey(),
  accountId: integer("accountId").notNull(),
  instanceId: varchar("instanceId", { length: 64 }).notNull(),
  instanceName: varchar("instanceName", { length: 120 }),
  /**
   * Where this instance was when this service last resolved it itself.
   *
   * The grant list is where a person decides whether to keep trusting a
   * server, and until now it offered them a sixteen-character hex id and a
   * display name the server chose for itself. That is not enough to recognise
   * anything — least of all after a desktop host is restored or changes port,
   * where an unreadable id may be the only thing telling two grants apart.
   *
   * **Only ever written from an origin resolved here** — the `returnUrl`
   * target in the browser flow, whose descriptor this service fetched. Never
   * from a request body. An address chosen by the party being authorised and
   * then displayed inside a security screen is a phishing primitive; the value
   * of this column is precisely that it is an observation rather than a claim.
   *
   * Null means this grant has only ever been seen through the API token flow,
   * which carries no origin. The list says so rather than showing a blank.
   */
  instanceUrl: varchar("instanceUrl", { length: 255 }),
  firstUsedAt: timestamp("firstUsedAt").defaultNow().notNull(),
  lastUsedAt: timestamp("lastUsedAt").defaultNow().notNull(),
  revokedAt: timestamp("revokedAt"),
});
