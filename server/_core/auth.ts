import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import type { Request, Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import type { User } from "../../drizzle/schema";
import { getUserById } from "../db";
import { getSessionCookieOptions } from "./cookies";

function scryptAsync(
  password: string,
  salt: string,
  keylen: number,
  options: ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) =>
      err ? reject(err) : resolve(derivedKey)
    );
  });
}

// -- Password hashing (scrypt, no native deps) --------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST)) as Buffer;
  return `scrypt:${SCRYPT_COST.N}:${SCRYPT_COST.r}:${SCRYPT_COST.p}:${salt}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, N, r, p, salt, hashHex] = stored.split(":");
    if (scheme !== "scrypt") return false;
    const expected = Buffer.from(hashHex, "hex");
    const derived = (await scryptAsync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    })) as Buffer;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// -- Session tokens (JWT via jose) --------------------------------------------

const SESSION_TTL_MS = ONE_YEAR_MS;

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(userId: number): Promise<string> {
  return await new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor((Date.now() + SESSION_TTL_MS) / 1000))
    .sign(getSecret());
}

export async function verifySessionToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      algorithms: ["HS256"],
    });
    const id = Number(payload.sub);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    ...getSessionCookieOptions(req),
    maxAge: SESSION_TTL_MS,
  });
}

// -- Request authentication ----------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Resolve the authenticated DB user from the session cookie (preferred)
 * or an Authorization: Bearer token. Returns null when unauthenticated.
 */
export async function authenticateRequest(req: Request): Promise<User | null> {
  let token = parseCookies(req.headers.cookie)[COOKIE_NAME];

  if (!token) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      token = authHeader.slice(7);
    }
  }
  if (!token) return null;

  const userId = await verifySessionToken(token);
  if (!userId) return null;

  return await getUserById(userId);
}

// -- Login rate limiting (in-memory, per key) ---------------------------------

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function checkLoginRateLimit(key: string): boolean {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  entry.count += 1;
  return entry.count <= MAX_ATTEMPTS;
}

export function resetLoginRateLimit(key: string): void {
  attempts.delete(key);
}
