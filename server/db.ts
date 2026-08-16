import { eq, and, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { InsertUser, users, servers, channels, messages, fileShares, soundboardClips, serverMembers, serverBans, userProfiles, instanceSettings } from "../drizzle/schema";
import { ENV } from './_core/env';

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
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
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
    if (updateSet.email !== undefined) conflictUpdateSet.email = updateSet.email;
    if (updateSet.loginMethod !== undefined) conflictUpdateSet.loginMethod = updateSet.loginMethod;
    if (updateSet.role !== undefined) conflictUpdateSet.role = updateSet.role;
    if (updateSet.lastSignedIn !== undefined) conflictUpdateSet.lastSignedIn = updateSet.lastSignedIn;
    await db.insert(users).values(values).onConflictDoUpdate({
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

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

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

export async function createLocalUser(
  email: string,
  passwordHash: string,
  name?: string,
  role: "user" | "admin" = "user"
) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(users)
    .values({
      openId: `local:${crypto.randomUUID()}`,
      email: email.toLowerCase(),
      passwordHash,
      name: name ?? email.split("@")[0],
      loginMethod: "password",
      role,
    })
    .returning();
  return result[0];
}

/**
 * How many accounts exist.
 *
 * Used to decide whether a registration is the very first one — the person
 * setting the instance up — and therefore its administrator.
 */
export async function countUsers(): Promise<number> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(users);
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
export async function linkSsoSubject(userId: number, subject: string): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(users)
    .set({ ssoSubject: subject, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

/**
 * Create an account from a verified identity token.
 *
 * No password hash: this account signs in through sovrgnnet.cc. It can be
 * given a local password later, but it never has one implicitly.
 */
export async function createSsoUser(
  subject: string,
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
export async function createServer(name: string, description: string | undefined, matrixRoomId: string, ownerId: number, icon?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(servers).values({
    name,
    description,
    matrixRoomId,
    ownerId,
    icon,
    isPublic: true,
  }).returning();

  return result[0];
}

/** Servers the user owns or is a member of. */
export async function getServersByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const owned = await db.select().from(servers).where(eq(servers.ownerId, userId));
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

  const result = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Channel functions
export async function createChannel(serverId: number, name: string, description: string | undefined, matrixRoomId: string, type: 'text' | 'voice' | 'video' = 'text') {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(channels).values({
    serverId,
    name,
    description,
    matrixRoomId,
    type,
    isPrivate: false,
  }).returning();
  return result[0];
}

export async function getChannelsByServer(serverId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.select().from(channels).where(eq(channels.serverId, serverId));
}

export async function getChannelById(channelId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Message functions
export async function createMessage(channelId: number, userId: number, content: string, matrixEventId: string, encrypted: boolean = true) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(messages).values({
    channelId,
    userId,
    content,
    matrixEventId,
    encrypted,
  }).returning();
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
      encrypted: messages.encrypted,
      createdAt: messages.createdAt,
      editedAt: messages.editedAt,
      reactions: messages.reactions,
      accountName: users.name,
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
    senderName: displayName(row.nickname, row.accountName),
    senderAvatar: row.memberAvatar,
  }));
}

/**
 * Which name to show for someone in a given server.
 *
 * Per-server nickname wins; the account name is the fallback. A nickname of
 * whitespace is treated as unset rather than rendering as a blank author.
 */
export function displayName(
  nickname: string | null | undefined,
  accountName: string | null | undefined
): string | null {
  const trimmed = nickname?.trim();
  if (trimmed) return trimmed;
  return accountName ?? null;
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
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
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
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
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
export async function getUserIdByMatrixId(matrixUserId: string): Promise<number | null> {
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
  userId: number,
  content: string,
  matrixEventId: string,
  encrypted: boolean,
  originServerTs?: number
): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .insert(messages)
    .values({
      channelId,
      userId,
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
export async function markChannelEncrypted(matrixRoomId: string): Promise<boolean> {
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
export async function deleteMessageByEventId(matrixEventId: string): Promise<boolean> {
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
    await db.insert(userProfiles).values({ userId, matrixUserId, matrixAccessToken });
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

export async function setServerInviteCode(serverId: number, code: string): Promise<void> {
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

  const result = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function deleteMessage(messageId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.delete(messages).where(eq(messages.id, messageId));
}

export async function removeServerMember(serverId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .delete(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
}

export async function isServerMember(serverId: number, userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const server = await getServerById(serverId);
  if (server?.ownerId === userId) return true;

  const rows = await db
    .select({ id: serverMembers.id })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// File share functions
export async function createFileShare(channelId: number, userId: number, filename: string, ipfsHash: string, fileSize: number, mimeType?: string, torrentMagnetLink?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.insert(fileShares).values({
    channelId,
    userId,
    filename,
    ipfsHash,
    fileSize,
    mimeType,
    torrentMagnetLink,
  }).returning();
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

export async function getFileShareByCid(cid: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db
    .select()
    .from(fileShares)
    .where(eq(fileShares.ipfsHash, cid))
    .limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Soundboard functions
export async function createSoundboardClip(serverId: number, name: string, ipfsHash: string, duration: number, uploadedBy: number) {
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

  return await db.select().from(soundboardClips).where(eq(soundboardClips.serverId, serverId));
}

// User profile functions
export async function createOrUpdateUserProfile(userId: number, walletAddress?: string, ensName?: string, avatar?: string, bio?: string, matrixUserId?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const existing = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);

  if (existing.length > 0) {
    return await db.update(userProfiles).set({
      walletAddress,
      ensName,
      avatar,
      bio,
      matrixUserId,
      updatedAt: new Date(),
    }).where(eq(userProfiles.userId, userId));
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

  const result = await db.select().from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

// Server member functions
export async function addServerMember(serverId: number, userId: number, role: 'owner' | 'admin' | 'moderator' | 'member' = 'member') {
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

  return await db.select().from(serverMembers).where(eq(serverMembers.serverId, serverId));
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
      matrixUserId: userProfiles.matrixUserId,
    })
    .from(serverMembers)
    .leftJoin(users, eq(serverMembers.userId, users.id))
    .leftJoin(userProfiles, eq(serverMembers.userId, userProfiles.userId))
    .where(eq(serverMembers.serverId, serverId));

  return rows.map(row => ({ ...row, name: displayName(row.nickname, row.accountName) }));
}

export async function getServerMemberRole(
  serverId: number,
  userId: number
): Promise<'owner' | 'admin' | 'moderator' | 'member' | null> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ role: serverMembers.role })
    .from(serverMembers)
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function setServerMemberRole(
  serverId: number,
  userId: number,
  role: 'owner' | 'admin' | 'moderator' | 'member'
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .update(serverMembers)
    .set({ role })
    .where(and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)));
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

export async function unbanServerMember(serverId: number, userId: number): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db
    .delete(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId)));
}

export async function isServerBanned(serverId: number, userId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const rows = await db
    .select({ id: serverBans.id })
    .from(serverBans)
    .where(and(eq(serverBans.serverId, serverId), eq(serverBans.userId, userId)))
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

export async function setUserRole(userId: number, role: "user" | "admin"): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
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

  const current: ReactionMap = { ...((message.reactions as ReactionMap | null) ?? {}) };
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
