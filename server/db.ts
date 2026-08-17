import { eq, and, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  USERNAME_MAX_LENGTH,
  checkUsername,
  foldUsername,
} from "@shared/username";
import {
  InsertUser,
  users,
  servers,
  channels,
  messages,
  fileShares,
  soundboardClips,
  serverMembers,
  serverBans,
  userProfiles,
  instanceSettings,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const client = postgres(process.env.DATABASE_URL);
      _db = drizzle(client);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/**
 * Does the database actually answer?
 *
 * Deliberately separate from every other query in this file. The rest swallow
 * errors and fall back, because a server that can't read one row should still
 * serve traffic on defaults. That policy is right for request handling and
 * exactly wrong for a readiness probe: `/ready` reported `database: "ok"`
 * against a DATABASE_URL pointing nowhere, because the function it called
 * caught the failure and returned null exactly as designed.
 *
 * A readiness check that cannot fail is not a check. This one round-trips.
 */
export async function pingDatabase(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.DATABASE_URL) {
    return { ok: false, error: "DATABASE_URL is not set" };
  }

  const db = await getDb();
  if (!db) return { ok: false, error: "no database connection" };

  try {
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
      username: user.username,
      usernameFold: foldUsername(user.username),
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    // For PostgreSQL, use onConflictDoUpdate
    const conflictUpdateSet: any = {};
    if (updateSet.name !== undefined) conflictUpdateSet.name = updateSet.name;
    if (updateSet.email !== undefined)
      conflictUpdateSet.email = updateSet.email;
    if (updateSet.loginMethod !== undefined)
      conflictUpdateSet.loginMethod = updateSet.loginMethod;
    if (updateSet.role !== undefined) conflictUpdateSet.role = updateSet.role;
    if (updateSet.lastSignedIn !== undefined)
      conflictUpdateSet.lastSignedIn = updateSet.lastSignedIn;
    await db
      .insert(users)
      .values(values)
      .onConflictDoUpdate({
        target: users.openId,
        set: conflictUpdateSet as any,
      });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUserById(id: number) {
  const db = await getDb();
  if (!db) return null;

  const result = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return result.length > 0 ? result[0] : null;
}

export async function getUserByEmail(email: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

/**
 * Look an account up by the name someone typed.
 *
 * Matches on the fold rather than the stored username, so `alice.hart` finds
 * the account registered as `alice_hart`. That is the same rule the unique
 * index enforces: if two spellings cannot both exist, then either spelling has
 * to find the one that does — otherwise a name would be simultaneously taken
 * and unfindable.
 */
export async function getUserByUsername(username: string) {
  const db = await getDb();
  if (!db) return null;

  const result = await db
    .select()
    .from(users)
    .where(eq(users.usernameFold, foldUsername(username)))
    .limit(1);
  return result.length > 0 ? result[0] : null;
}

/**
 * Change an account's username.
 *
 * **This does not change the Matrix ID, and cannot.** See ADR 0012. The MXID
 * lives in `userProfiles.matrixUserId` and is deliberately untouched here —
 * every existing message, membership and power level is keyed to it on the
 * homeserver, and Matrix has no rename.
 *
 * Returns `null` when the new name is taken. That is reported as a normal
 * outcome rather than thrown, because "someone has that name" is an answer to
 * the question, not a failure to answer it — and the caller has a specific
 * message for it.
 *
 * The uniqueness check and the write are one statement: a `SELECT` followed by
 * an `UPDATE` would leave a window where two people both see a free name. The
 * `WHERE NOT EXISTS` makes the database do the check at write time, and the
 * unique index on `usernameFold` is still there as the real guarantee if this
 * reasoning is ever wrong.
 */
export async function renameUser(
  userId: number,
  username: string
): Promise<{ id: number; username: string } | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const fold = foldUsername(username);

  const updated = await db
    .update(users)
    .set({ username, usernameFold: fold })
    .where(
      and(
        eq(users.id, userId),
        // Not taken by anyone else. Excluding this row means re-submitting the
        // name you already hold (or a case change of it) succeeds rather than
        // colliding with itself.
        sql`NOT EXISTS (
          SELECT 1 FROM ${users} AS existing
          WHERE existing."usernameFold" = ${fold}
            AND existing."id" <> ${userId}
        )`
      )
    )
    .returning({ id: users.id, username: users.username });

  return updated[0] ?? null;
}

/**
 * Create a local account.
 *
 * An options object rather than positional arguments, because email stopped
 * being required at the same time username started being required. Two
 * adjacent optional strings that both look like identifiers is a call site
 * waiting to be transposed, and the compiler cannot catch it.
 *
 * `username` must already have been through `checkUsername` — this stores what
 * it is given. The fold is derived here rather than accepted, so there is one
 * place it can be computed and no way for a caller to supply one that
 * disagrees with the name beside it.
 */
export async function createLocalUser(input: {
  username: string;
  passwordHash: string;
  /** Optional: accounts are identified by username, not by email. */
  email?: string | null;
  name?: string;
  role?: "user" | "admin";
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(users)
    .values({
      openId: `local:${crypto.randomUUID()}`,
      username: input.username,
      usernameFold: foldUsername(input.username),
      email: input.email ? input.email.toLowerCase() : null,
      passwordHash: input.passwordHash,
      // Falls back to the username, not to the email's local part: there may
      // not be an email any more.
      name: input.name ?? input.username,
      loginMethod: "password",
      role: input.role ?? "user",
    })
    .returning();
  return result[0];
}

/**
 * Lock number for the bootstrap decision.
 *
 * Arbitrary, and only has to be distinct from any other advisory lock this
 * codebase takes. There are currently none, so this is the whole registry.
 */
const BOOTSTRAP_LOCK_KEY = 8_051_001;

/**
 * Create an account, deciding under a lock whether it is the bootstrap.
 *
 * The old shape was `countUsers() === 0` followed by `createLocalUser(...)`,
 * which is a check and an act with a gap between them. Two registrations
 * arriving together both read zero and both become administrators — and since
 * "first to register owns the instance" is the whole rule, that gap is also
 * the window in which a stranger races the operator for a server that has just
 * been pointed at a public address.
 *
 * `pg_advisory_xact_lock` serialises the decision. It is a lock on a number,
 * held to the end of the transaction, and it needs no table and no migration —
 * which matters because the alternative, a unique partial index on
 * `role = 'admin'`, would also permanently forbid a second administrator and
 * break granting.
 *
 * The policy stays out of here. `decide` receives the count observed *inside*
 * the lock and returns a role or a refusal, so `canRegister` remains a pure
 * function that tests without a database, while the thing it decides about
 * can no longer change underneath it.
 */
export async function createUserUnderBootstrapLock(
  input: {
    username: string;
    passwordHash: string;
    email?: string | null;
    name?: string;
  },
  decide: (
    isFirstAccount: boolean
  ) =>
    | { allowed: true; role: "user" | "admin" }
    | { allowed: false; message: string }
): Promise<
  | { ok: true; user: Awaited<ReturnType<typeof createLocalUser>> }
  | { ok: false; message: string }
> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.transaction(async tx => {
    // An arbitrary constant, scoped to this decision. Any other transaction
    // taking the same number waits here rather than reading a stale count.
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`);

    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(users);
    const isFirstAccount = Number(rows[0]?.count ?? 0) === 0;

    const verdict = decide(isFirstAccount);
    if (!verdict.allowed)
      return { ok: false as const, message: verdict.message };

    const [created] = await tx
      .insert(users)
      .values({
        openId: `local:${crypto.randomUUID()}`,
        username: input.username,
        usernameFold: foldUsername(input.username),
        email: input.email ? input.email.toLowerCase() : null,
        passwordHash: input.passwordHash,
        name: input.name ?? input.username,
        loginMethod: "password",
        role: verdict.role,
      })
      .returning();

    return { ok: true as const, user: created };
  });
}

/**
 * How many accounts exist.
 *
 * Used to decide whether a registration is the very first one — the person
 * setting the instance up — and therefore its administrator.
 *
 * Read outside a transaction, so it is only safe for *reporting*. Anything
 * that acts on the answer must use `createUserUnderBootstrapLock`.
 */
export async function countUsers(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users);
  return Number(rows[0]?.count ?? 0);
}

export async function getUserBySsoSubject(subject: string) {
  const db = await getDb();
  if (!db) return null;

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.ssoSubject, subject))
    .limit(1);
  return rows[0] ?? null;
}

/** Bind an existing local account to a sovrgnnet.cc identity. */
export async function linkSsoSubject(
  userId: number,
  subject: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(users)
    .set({ ssoSubject: subject, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * A username the person might want, offered as a starting point.
 *
 * Only ever a *suggestion* shown in a field they can edit. It replaced a
 * function that silently assigned this value, which was wrong for one reason
 * worth stating: a username becomes a permanent Matrix localpart, and Matrix
 * has no rename. Choosing it for someone and making the choice permanent is
 * the same thing the 0009 migration refuses to do for existing accounts.
 *
 * Returns null when nothing usable can be made from what the provider sent, in
 * which case the field simply starts empty. An empty field is a fine outcome;
 * a wrong permanent name is not.
 */
export async function suggestUsername(
  preferred: string | null
): Promise<string | null> {
  // Display names carry spaces, apostrophes and emoji, so this reduces to the
  // allowed shape rather than trusting the provider's string.
  const base = (preferred ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, USERNAME_MAX_LENGTH - 3);
  if (!base) return null;

  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`;
    if (!checkUsername(candidate).ok) continue;
    if (!(await getUserByUsername(candidate))) return candidate;
  }
  // Everything nearby is taken. Better to offer nothing than to offer a name
  // that will be rejected the moment they press the button.
  return null;
}

/**
 * Create an account from a verified identity token.
 *
 * No password hash: this account signs in through sovrgnnet.cc. It can be
 * given a local password later, but it never has one implicitly.
 *
 * The username is chosen by the person and passed in, already validated. This
 * function will not invent one.
 */
export async function createSsoUser(
  subject: string,
  username: string,
  email: string | null,
  name: string | null,
  role: "user" | "admin" = "user"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(users)
    .values({
      openId: `sso:${subject}`,
      ssoSubject: subject,
      username,
      usernameFold: foldUsername(username),
      email: email?.toLowerCase() ?? null,
      name: name ?? email?.split("@")[0] ?? "New member",
      loginMethod: "sovrgnnet",
      role,
    })
    .returning();
  return result[0];
}

export async function touchLastSignedIn(userId: number): Promise<void> {
  const db = await getDb();
  if (!db) return;

  await db
    .update(users)
    .set({ lastSignedIn: new Date() })
    .where(eq(users.id, userId));
}

// Server functions
export async function createServer(
  name: string,
  description: string | undefined,
  matrixRoomId: string,
  ownerId: number,
  icon?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(servers)
    .values({
      name,
      description,
      matrixRoomId,
      ownerId,
      icon,
      isPublic: true,
    })
    .returning();

  return result[0];
}

/** Servers the user owns or is a member of. */
export async function getServersByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const owned = await db
    .select()
    .from(servers)
    .where(eq(servers.ownerId, userId));
  const memberRows = await db
    .select({ server: servers })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, userId));

  const seen = new Set(owned.map(s => s.id));
  const joined = memberRows.map(r => r.server).filter(s => !seen.has(s.id));
  return [...owned, ...joined];
}

export async function getPublicServers(limit = 50) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(servers)
    .where(eq(servers.isPublic, true))
    .limit(limit);
}

export async function getServerById(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Channel functions
export async function createChannel(
  serverId: number,
  name: string,
  description: string | undefined,
  matrixRoomId: string,
  type: "text" | "voice" | "video" = "text",
  /**
   * Whether `m.room.encryption` was actually set on the room.
   *
   * Passed in rather than derived from the instance's capability. The state
   * event can fail on its own, and a channel marked encrypted that isn't would
   * put a lock icon over plaintext — which is the one direction this flag must
   * never be wrong in.
   */
  encrypted: boolean = false
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(channels)
    .values({
      serverId,
      name,
      description,
      matrixRoomId,
      type,
      isPrivate: false,
      encrypted,
    })
    .returning();
  return result[0];
}

export async function getChannelsByServer(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(channels)
    .where(eq(channels.serverId, serverId));
}

export async function getChannelById(channelId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Message functions
export async function createMessage(
  channelId: number,
  userId: number,
  content: string,
  matrixEventId: string,
  encrypted: boolean = true,
  senderMatrixId?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(messages)
    .values({
      channelId,
      userId,
      senderMatrixId: senderMatrixId ?? null,
      content,
      matrixEventId,
      encrypted,
    })
    .returning();
  return result[0];
}

/**
 * Messages with sender names, oldest first.
 *
 * The sender's name is their per-server nickname when they've set one, and
 * their account name otherwise — so someone can be "Zach" in one community and
 * "chronus" in another without two accounts.
 */
export async function getMessagesByChannel(
  channelId: number,
  limit: number = 50,
  serverId?: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      id: messages.id,
      channelId: messages.channelId,
      userId: messages.userId,
      content: messages.content,
      matrixEventId: messages.matrixEventId,
      senderMatrixId: messages.senderMatrixId,
      encrypted: messages.encrypted,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      reactions: messages.reactions,
      accountName: users.name,
      accountUsername: users.username,
      nickname: serverMembers.nickname,
      memberAvatar: serverMembers.avatar,
    })
    .from(messages)
    .leftJoin(users, eq(messages.userId, users.id))
    .leftJoin(
      serverMembers,
      serverId === undefined
        ? sql`false`
        : and(
            eq(serverMembers.userId, messages.userId),
            eq(serverMembers.serverId, serverId)
          )
    )
    .where(eq(messages.channelId, channelId))
    .orderBy(sql`${messages.createdAt} DESC`)
    .limit(limit);

  return rows.reverse().map(row => ({
    ...row,
    // Nickname, then account name, then username. Only a *federated* sender
    // has none of the three — the join is on users.id, which a remote sender
    // has no row in — so the Matrix ID fallback now means what it says (ADR
    // 0010) instead of also catching local accounts that never set a display
    // name. Those used to render as @alice:example.org to their own community.
    senderName:
      displayName(row.nickname, row.accountName, row.accountUsername) ??
      row.senderMatrixId,
    senderAvatar: row.memberAvatar,
  }));
}

/**
 * Which name to show for someone in a given server.
 *
 * Per-server nickname, then account name, then username. A nickname of
 * whitespace is treated as unset rather than rendering as a blank author.
 *
 * The username tail matters more than it used to. A display name has always
 * been optional, and before #29 an account without one had only an email to
 * fall back on — which is not something to render in a member list — so the UI
 * showed "Unknown". Now every account has a username by construction, so there
 * is a real name to show and nobody needs to appear as Unknown to their own
 * community.
 *
 * Still nullable: a federated sender has none of the three, and their Matrix ID
 * is the honest fallback there (ADR 0010). Returning null rather than inventing
 * something keeps that decision at the call site that knows about federation.
 */
export function displayName(
  nickname: string | null | undefined,
  accountName: string | null | undefined,
  username?: string | null
): string | null {
  const trimmed = nickname?.trim();
  if (trimmed) return trimmed;
  return accountName ?? username ?? null;
}

/** Set or clear the current user's profile within one server. */
export async function setServerProfile(
  serverId: number,
  userId: number,
  values: { nickname?: string | null; avatar?: string | null }
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(serverMembers)
    .set(values)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    );
}

export async function getServerProfile(serverId: number, userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      nickname: serverMembers.nickname,
      avatar: serverMembers.avatar,
      role: serverMembers.role,
    })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Instance-level totals for /metrics. Totals only — see server/metrics.ts. */
export async function countTotals(): Promise<{
  users: number;
  servers: number;
  messages: number;
}> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [userRows, serverRows, messageRows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(users),
    db.select({ n: sql<number>`count(*)::int` }).from(servers),
    db.select({ n: sql<number>`count(*)::int` }).from(messages),
  ]);
  return {
    users: userRows[0]?.n ?? 0,
    servers: serverRows[0]?.n ?? 0,
    messages: messageRows[0]?.n ?? 0,
  };
}

// Matrix credential storage (userProfiles)
export async function getMatrixCredentials(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      matrixUserId: userProfiles.matrixUserId,
      matrixAccessToken: userProfiles.matrixAccessToken,
    })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row?.matrixUserId || !row?.matrixAccessToken) return null;
  return { userId: row.matrixUserId, accessToken: row.matrixAccessToken };
}

/** Reverse of getMatrixCredentials: which of our users is this Matrix id? */
export async function getUserIdByMatrixId(
  matrixUserId: string
): Promise<number | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ userId: userProfiles.userId })
    .from(userProfiles)
    .where(eq(userProfiles.matrixUserId, matrixUserId))
    .limit(1);
  return rows[0]?.userId ?? null;
}

export async function getChannelByMatrixRoomId(matrixRoomId: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.matrixRoomId, matrixRoomId))
    .limit(1);
  return rows.length > 0 ? rows[0] : undefined;
}

/**
 * Record an event pushed by the homeserver (ADR 0009). Idempotent by event id:
 * during migration the API path and the appservice both write, and whoever
 * lands second must be a no-op rather than an error.
 *
 * Returns true when a row was inserted, false when it already existed.
 */
export async function ingestMessage(
  channelId: number,
  /** Null for federated senders — a Matrix id with no local account (ADR 0010). */
  userId: number | null,
  content: string,
  matrixEventId: string,
  encrypted: boolean,
  originServerTs?: number,
  senderMatrixId?: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(messages)
    .values({
      channelId,
      userId,
      senderMatrixId: senderMatrixId ?? null,
      content,
      matrixEventId,
      encrypted,
      // The homeserver's timestamp, not ingest time — ordering must agree
      // with what synced clients saw, or history reads differently per path.
      ...(originServerTs ? { createdAt: new Date(originServerTs) } : {}),
    })
    .onConflictDoNothing({ target: messages.matrixEventId })
    .returning({ id: messages.id });
  return result.length > 0;
}

/**
 * The homeserver told us a room turned on encryption. One-way by design:
 * Matrix itself never downgrades m.room.encryption, so neither do we.
 */
export async function markChannelEncrypted(
  matrixRoomId: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(channels)
    .set({ encrypted: true, updatedAt: new Date() })
    .where(eq(channels.matrixRoomId, matrixRoomId))
    .returning({ id: channels.id });
  return result.length > 0;
}

/** Apply an m.replace (edit) that arrived from the homeserver. */
export async function applyEditByEventId(
  targetEventId: string,
  newContent: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(messages)
    .set({ content: newContent, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(messages.matrixEventId, targetEventId))
    .returning({ id: messages.id });
  return result.length > 0;
}

/** Apply a redaction that arrived from the homeserver. */
export async function deleteMessageByEventId(
  matrixEventId: string
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .delete(messages)
    .where(eq(messages.matrixEventId, matrixEventId))
    .returning({ id: messages.id });
  return result.length > 0;
}

export async function saveMatrixCredentials(
  userId: number,
  matrixUserId: string,
  matrixAccessToken: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userProfiles)
      .set({ matrixUserId, matrixAccessToken, updatedAt: new Date() })
      .where(eq(userProfiles.userId, userId));
  } else {
    await db
      .insert(userProfiles)
      .values({ userId, matrixUserId, matrixAccessToken });
  }
}

export async function getServerByInviteCode(code: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(servers)
    .where(eq(servers.inviteCode, code))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function setServerInviteCode(
  serverId: number,
  code: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(servers)
    .set({ inviteCode: code, updatedAt: new Date() })
    .where(eq(servers.id, serverId));
}

export async function getMessageById(messageId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function deleteMessage(messageId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(messages).where(eq(messages.id, messageId));
}

export async function removeServerMember(
  serverId: number,
  userId: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .delete(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    );
}

export async function isServerMember(
  serverId: number,
  userId: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const server = await getServerById(serverId);
  if (server?.ownerId === userId) return true;

  const rows = await db
    .select({ id: serverMembers.id })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .limit(1);
  return rows.length > 0;
}

// File share functions
export async function createFileShare(
  channelId: number,
  userId: number,
  filename: string,
  ipfsHash: string,
  fileSize: number,
  mimeType?: string,
  torrentMagnetLink?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(fileShares)
    .values({
      channelId,
      userId,
      filename,
      ipfsHash,
      fileSize,
      mimeType,
      torrentMagnetLink,
    })
    .returning();
  return result[0];
}

/** File shares with uploader names, oldest first. */
export async function getFileSharesByChannel(channelId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select({
      id: fileShares.id,
      channelId: fileShares.channelId,
      userId: fileShares.userId,
      filename: fileShares.filename,
      ipfsHash: fileShares.ipfsHash,
      fileSize: fileShares.fileSize,
      mimeType: fileShares.mimeType,
      createdAt: fileShares.createdAt,
      senderName: users.name,
    })
    .from(fileShares)
    .leftJoin(users, eq(fileShares.userId, users.id))
    .where(eq(fileShares.channelId, channelId))
    .orderBy(fileShares.createdAt);
}

/**
 * Every share of a CID — plural, deliberately.
 *
 * The same bytes shared into two channels are one CID and two rows, because
 * content addressing is content addressing. Taking the first row and checking
 * membership against *its* channel refuses people who are entitled to the file
 * through the other one, with a 403 whose truth depends on insertion order.
 * Callers have to consider all of them.
 */
export async function getFileSharesByCid(cid: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.select().from(fileShares).where(eq(fileShares.ipfsHash, cid));
}

export async function getFileShareById(shareId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(fileShares)
    .where(eq(fileShares.id, shareId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

/**
 * Remove a share the uploader is abandoning, and say whether it was the last
 * one pointing at those bytes.
 *
 * The caller needs that second fact before unpinning: the same CID may be
 * shared in another channel, and unpinning it there because this upload failed
 * would delete somebody else's working file. Scoped to the owner in the same
 * statement, so a lost race deletes nothing rather than deleting a row that
 * stopped being theirs between the check and the write.
 */
export async function deleteOwnFileShare(
  shareId: number,
  userId: number
): Promise<{ deleted: boolean; cid: string | null; cidStillShared: boolean }> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const [removed] = await db
    .delete(fileShares)
    .where(and(eq(fileShares.id, shareId), eq(fileShares.userId, userId)))
    .returning({ ipfsHash: fileShares.ipfsHash });

  if (!removed) return { deleted: false, cid: null, cidStillShared: false };

  const remaining = await db
    .select({ id: fileShares.id })
    .from(fileShares)
    .where(eq(fileShares.ipfsHash, removed.ipfsHash))
    .limit(1);

  return {
    deleted: true,
    cid: removed.ipfsHash,
    cidStillShared: remaining.length > 0,
  };
}

// Soundboard functions
export async function createSoundboardClip(
  serverId: number,
  name: string,
  ipfsHash: string,
  duration: number,
  uploadedBy: number
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(soundboardClips).values({
    serverId,
    name,
    ipfsHash,
    duration,
    uploadedBy,
  });
}

export async function getSoundboardClipsByServer(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(soundboardClips)
    .where(eq(soundboardClips.serverId, serverId));
}

// User profile functions
export async function createOrUpdateUserProfile(
  userId: number,
  walletAddress?: string,
  ensName?: string,
  avatar?: string,
  bio?: string,
  matrixUserId?: string
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    return await db
      .update(userProfiles)
      .set({
        walletAddress,
        ensName,
        avatar,
        bio,
        matrixUserId,
        updatedAt: new Date(),
      })
      .where(eq(userProfiles.userId, userId));
  }

  return await db.insert(userProfiles).values({
    userId,
    walletAddress,
    ensName,
    avatar,
    bio,
    matrixUserId,
  });
}

export async function getUserProfile(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Server member functions
export async function addServerMember(
  serverId: number,
  userId: number,
  role: "owner" | "admin" | "moderator" | "member" = "member"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(serverMembers).values({
    serverId,
    userId,
    role,
  });
}

export async function getServerMembers(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select()
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));
}

/** Members with display names and Matrix ids, owners first. */
export async function getServerMembersDetailed(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({
      userId: serverMembers.userId,
      role: serverMembers.role,
      joinedAt: serverMembers.joinedAt,
      accountName: users.name,
      nickname: serverMembers.nickname,
      avatar: serverMembers.avatar,
      email: users.email,
      username: users.username,
      matrixUserId: userProfiles.matrixUserId,
    })
    .from(serverMembers)
    .leftJoin(users, eq(serverMembers.userId, users.id))
    .leftJoin(userProfiles, eq(serverMembers.userId, userProfiles.userId))
    .where(eq(serverMembers.serverId, serverId));

  return rows.map(row => ({
    ...row,
    name: displayName(row.nickname, row.accountName, row.username),
  }));
}

export async function getServerMemberRole(
  serverId: number,
  userId: number
): Promise<"owner" | "admin" | "moderator" | "member" | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function setServerMemberRole(
  serverId: number,
  userId: number,
  role: "owner" | "admin" | "moderator" | "member"
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(serverMembers)
    .set({ role })
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    );
}

export async function banServerMember(
  serverId: number,
  userId: number,
  bannedBy: number,
  reason?: string
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const already = await isServerBanned(serverId, userId);
  if (already) return;

  await db.insert(serverBans).values({ serverId, userId, bannedBy, reason });
}

export async function unbanServerMember(
  serverId: number,
  userId: number
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .delete(serverBans)
    .where(
      and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId))
    );
}

export async function isServerBanned(
  serverId: number,
  userId: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ id: serverBans.id })
    .from(serverBans)
    .where(
      and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId))
    )
    .limit(1);
  return rows.length > 0;
}

export async function getServerBans(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select({
      userId: serverBans.userId,
      reason: serverBans.reason,
      createdAt: serverBans.createdAt,
      name: users.name,
    })
    .from(serverBans)
    .leftJoin(users, eq(serverBans.userId, users.id))
    .where(eq(serverBans.serverId, serverId));
}

/** Everyone with an account here, for the admin surface. Never exposes hashes. */
export async function listUsers() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      role: users.role,
      createdAt: users.createdAt,
      lastSignedIn: users.lastSignedIn,
    })
    .from(users)
    .orderBy(users.createdAt);
}

export async function setUserRole(
  userId: number,
  role: "user" | "admin"
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(users)
    .set({ role, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

// Instance settings — one row, id 1. Absent until an admin saves something,
// at which point it takes precedence over the environment.
export async function getInstanceSettings() {
  const db = await getDb();
  if (!db) return null;

  try {
    const rows = await db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    // A server that can't read its own settings should still serve traffic
    // on environment defaults rather than fail to start.
    return null;
  }
}

export async function saveInstanceSettings(values: {
  name?: string | null;
  description?: string | null;
  joinPolicy?: string;
  listed?: boolean;
}) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await getInstanceSettings();
  if (existing) {
    const result = await db
      .update(instanceSettings)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(instanceSettings.id, 1))
      .returning();
    return result[0];
  }

  const result = await db
    .insert(instanceSettings)
    .values({ id: 1, ...values })
    .returning();
  return result[0];
}

/** The Matrix user id for an app user, if they've been provisioned. */
export async function getMatrixUserId(userId: number): Promise<string | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ matrixUserId: userProfiles.matrixUserId })
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .limit(1);
  return rows[0]?.matrixUserId ?? null;
}

/** Replace a message's text and stamp it as edited. */
export async function updateMessageContent(messageId: number, content: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .update(messages)
    .set({ content, editedAt: new Date(), updatedAt: new Date() })
    .where(eq(messages.id, messageId))
    .returning();
  return result[0];
}

/** emoji -> list of user ids who reacted with it */
export type ReactionMap = Record<string, number[]>;

export async function setMessageReactions(
  messageId: number,
  reactions: ReactionMap
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(messages)
    .set({ reactions, updatedAt: new Date() })
    .where(eq(messages.id, messageId));
}

/**
 * Add or remove one user's reaction, returning the updated map.
 *
 * Read-modify-write on a JSON column: two people reacting in the same
 * millisecond could lose one reaction. That's an acceptable trade for now
 * against a separate table and a join on every message fetch — and reactions
 * are cheap to re-add. Revisit if it ever actually bites.
 */
export async function toggleMessageReaction(
  messageId: number,
  userId: number,
  emoji: string
): Promise<ReactionMap> {
  const message = await getMessageById(messageId);
  if (!message) throw new Error("Message not found");

  const current: ReactionMap = {
    ...((message.reactions as ReactionMap | null) ?? {}),
  };
  const reactors = new Set(current[emoji] ?? []);

  if (reactors.has(userId)) {
    reactors.delete(userId);
  } else {
    reactors.add(userId);
  }

  if (reactors.size === 0) {
    delete current[emoji];
  } else {
    current[emoji] = Array.from(reactors);
  }

  await setMessageReactions(messageId, current);
  return current;
}
