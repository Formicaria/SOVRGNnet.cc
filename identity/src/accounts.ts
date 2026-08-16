import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number
) => Promise<Buffer>;

/**
 * Passwords and opaque tokens for the identity provider.
 *
 * Deliberately the same shape as the main server's auth: scrypt, no native
 * dependencies, salt stored alongside the hash. Two different password
 * implementations in one project is one more than anybody can keep correct.
 */

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), KEY_LENGTH);
  const expected = Buffer.from(hashHex, "hex");
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * The account's permanent public identifier, which becomes a token's `sub`.
 *
 * Random rather than derived from the email, because people change email
 * addresses and every server on the network keys their local account off this
 * value. If it moved, everyone would silently become a stranger.
 */
export function generateSubject(): string {
  return `acct_${randomBytes(16).toString("hex")}`;
}

/**
 * Opaque tokens for sessions and email links.
 *
 * Stored as hashes, so a leak of the database is not a leak of working
 * sessions or reset links. The plaintext exists only in the cookie or the
 * emailed URL.
 */
export function generateOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Case- and whitespace-insensitive, the way people actually type addresses. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
