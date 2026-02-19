import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, servers, channels, messages, fileShares, soundboardClips, nitroSubscriptions, serverMembers, userProfiles } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
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
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
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
  });

  return result;
}

export async function getServersByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.select().from(servers).where(eq(servers.ownerId, userId));
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

  return await db.insert(channels).values({
    serverId,
    name,
    description,
    matrixRoomId,
    type,
    isPrivate: false,
  });
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

  return await db.insert(messages).values({
    channelId,
    userId,
    content,
    matrixEventId,
    encrypted,
  });
}

export async function getMessagesByChannel(channelId: number, limit: number = 50) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.select().from(messages).where(eq(messages.channelId, channelId)).limit(limit);
}

// File share functions
export async function createFileShare(channelId: number, userId: number, filename: string, ipfsHash: string, fileSize: number, mimeType?: string, torrentMagnetLink?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(fileShares).values({
    channelId,
    userId,
    filename,
    ipfsHash,
    fileSize,
    mimeType,
    torrentMagnetLink,
  });
}

export async function getFileSharesByChannel(channelId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.select().from(fileShares).where(eq(fileShares.channelId, channelId));
}

// Soundboard functions
export async function createSoundboardClip(serverId: number, name: string, ipfsHash: string, duration: number, uploadedBy: number, isNitroOnly: boolean = false) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(soundboardClips).values({
    serverId,
    name,
    ipfsHash,
    duration,
    uploadedBy,
    isNitroOnly,
  });
}

export async function getSoundboardClipsByServer(serverId: number, includeNitroOnly: boolean = false) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  if (includeNitroOnly) {
    return await db.select().from(soundboardClips).where(eq(soundboardClips.serverId, serverId));
  }

  return await db.select().from(soundboardClips).where(and(eq(soundboardClips.serverId, serverId), eq(soundboardClips.isNitroOnly, false)));
}

// Nitro subscription functions
export async function createNitroSubscription(userId: number, walletAddress: string, nftContractAddress: string, nftTokenId: string, tier: 'basic' | 'pro' | 'ultra' = 'basic', expiresAt?: Date) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  return await db.insert(nitroSubscriptions).values({
    userId,
    walletAddress,
    nftContractAddress,
    nftTokenId,
    tier,
    expiresAt,
    isActive: true,
  });
}

export async function getNitroSubscriptionByUser(userId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const result = await db.select().from(nitroSubscriptions).where(eq(nitroSubscriptions.userId, userId)).limit(1);
  return result.length > 0 ? result[0] : undefined;
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
