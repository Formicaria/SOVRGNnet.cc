import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual,
  type KeyObject,
} from "node:crypto";

/**
 * Identity tokens issued by sovrgnnet.cc and verified by every server.
 *
 * This lives in shared/ because both ends need the identical format: the
 * provider signs, and each server verifies. Two implementations of a token
 * format is how signature bugs are born.
 *
 * ## Why Ed25519 and not a shared secret
 *
 * A shared secret would mean every server calls sovrgnnet.cc on every login,
 * making it a hard runtime dependency on the critical path — the exact failure
 * mode ADR 0003 exists to blunt. With public-key signatures a server fetches
 * the key once and can then verify tokens with the provider entirely
 * unreachable.
 *
 * ## Why tokens are bound to one server
 *
 * Every token names its audience: the instance id it was minted for. Without
 * that, a token handed to one server could be replayed against another by
 * whoever runs the first — so a malicious server operator could impersonate
 * their users everywhere. The audience check is not optional.
 *
 * Implemented on node:crypto rather than a JWT library, because Ed25519 JWTs
 * are three base64url segments and a signature, and this way the format has no
 * dependency that either side could resolve to a different version.
 */

export const TOKEN_ISSUER = "https://sovrgnnet.cc";
/** Deliberately short. These are bearer tokens; they get exchanged for a session. */
export const TOKEN_TTL_SECONDS = 300;
/** Tolerance for clock drift between the provider and a self-hosted server. */
export const CLOCK_SKEW_SECONDS = 60;

export type IdentityClaims = {
  /** Issuer — always sovrgnnet.cc. */
  iss: string;
  /** Stable, opaque account id. Never an email; emails change. */
  sub: string;
  /** The instance id this token may be presented to, and only that one. */
  aud: string;
  exp: number;
  iat: number;
  /** Unique id, so a server can reject a token it has already accepted. */
  jti: string;
  /** Display name, a convenience for first sign-in. Not authoritative. */
  name?: string;
  /** Whether the provider has verified the address. Gates account linking. */
  email_verified?: boolean;
  email?: string;
};

export type Jwk = {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  use: "sig";
  alg: "EdDSA";
};

export class TokenError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "TokenError";
  }
}

// ------------------------------------------------------------------ base64url

function b64u(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unb64u(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64");
}

// ----------------------------------------------------------------------- keys

export type Keypair = { privateKey: KeyObject; publicKey: KeyObject; kid: string };

/**
 * Derive a key id from the public key itself, so it's reproducible: the same
 * key always gets the same kid, on any machine, without storing it anywhere.
 */
export function keyId(publicKey: KeyObject): string {
  const raw = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!raw.x) throw new TokenError("Not an Ed25519 public key", "bad_key");
  return b64u(Buffer.from(raw.x, "base64url").subarray(0, 8));
}

export function generateKeypair(): Keypair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey, kid: keyId(publicKey) };
}

export function privateKeyFromPem(pem: string): Keypair {
  const privateKey = createPrivateKey(pem);
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: keyId(publicKey) };
}

export function publicKeyToJwk(publicKey: KeyObject): Jwk {
  const raw = publicKey.export({ format: "jwk" }) as { x?: string };
  if (!raw.x) throw new TokenError("Not an Ed25519 public key", "bad_key");
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: raw.x,
    kid: keyId(publicKey),
    use: "sig",
    alg: "EdDSA",
  };
}

export function jwkToPublicKey(jwk: Jwk): KeyObject {
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
    throw new TokenError("Unsupported key type", "bad_key");
  }
  // The DOM lib and node:crypto each declare a JsonWebKey and they aren't
  // structurally compatible; this file is Node-only, so Node's is the right one.
  type NodeJwk = Parameters<typeof createPublicKey>[0] extends infer T
    ? T extends { key: infer K; format: "jwk" }
      ? K
      : never
    : never;
  return createPublicKey({ key: jwk as unknown as NodeJwk, format: "jwk" });
}

// --------------------------------------------------------------------- issue

export function issueToken(
  keypair: Keypair,
  claims: {
    subject: string;
    audience: string;
    name?: string;
    email?: string;
    emailVerified?: boolean;
    ttlSeconds?: number;
    now?: number;
  }
): string {
  const now = claims.now ?? Math.floor(Date.now() / 1000);

  const header = { alg: "EdDSA", typ: "JWT", kid: keypair.kid };
  const payload: IdentityClaims = {
    iss: TOKEN_ISSUER,
    sub: claims.subject,
    aud: claims.audience,
    iat: now,
    exp: now + (claims.ttlSeconds ?? TOKEN_TTL_SECONDS),
    jti: b64u(randomBytes(16)),
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.email ? { email: claims.email } : {}),
    ...(claims.emailVerified !== undefined
      ? { email_verified: claims.emailVerified }
      : {}),
  };

  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  // Ed25519 takes a null algorithm — the curve determines the hash.
  const signature = cryptoSign(null, Buffer.from(signingInput), keypair.privateKey);
  return `${signingInput}.${b64u(signature)}`;
}

// -------------------------------------------------------------------- verify

/**
 * Verify a token and return its claims.
 *
 * Throws rather than returning null, because every failure here has a distinct
 * cause a server operator may need to see in a log — an expired token and a
 * forged one are very different events.
 */
export function verifyToken(
  token: string,
  options: {
    /** Public keys by kid. A server holds these from the provider's JWKS. */
    keys: Map<string, KeyObject>;
    /** This server's instance id. A token for anyone else is rejected. */
    audience: string;
    now?: number;
    clockSkewSeconds?: number;
  }
): IdentityClaims {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new TokenError("Malformed token", "malformed");
  }

  const [headerPart, payloadPart, signaturePart] = parts;

  let header: { alg?: string; kid?: string };
  let claims: IdentityClaims;
  try {
    header = JSON.parse(unb64u(headerPart).toString());
    claims = JSON.parse(unb64u(payloadPart).toString());
  } catch {
    throw new TokenError("Malformed token", "malformed");
  }

  // Refuse anything but EdDSA. Accepting the token's own word on the algorithm
  // is the classic JWT vulnerability — "alg": "none" and friends.
  if (header.alg !== "EdDSA") {
    throw new TokenError(`Unsupported algorithm: ${header.alg}`, "bad_algorithm");
  }
  if (!header.kid) {
    throw new TokenError("Token does not name a key", "no_kid");
  }

  const key = options.keys.get(header.kid);
  if (!key) {
    throw new TokenError(`Unknown signing key: ${header.kid}`, "unknown_key");
  }

  const valid = cryptoVerify(
    null,
    Buffer.from(`${headerPart}.${payloadPart}`),
    key,
    unb64u(signaturePart)
  );
  if (!valid) {
    throw new TokenError("Signature does not verify", "bad_signature");
  }

  if (claims.iss !== TOKEN_ISSUER) {
    throw new TokenError(`Unexpected issuer: ${claims.iss}`, "bad_issuer");
  }

  // Audience binding: without this, whoever runs one server could replay their
  // users' tokens against every other server on the network.
  if (claims.aud !== options.audience) {
    throw new TokenError("Token was issued for a different server", "bad_audience");
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;

  if (typeof claims.exp !== "number" || claims.exp + skew < now) {
    throw new TokenError("Token has expired", "expired");
  }
  if (typeof claims.iat !== "number" || claims.iat - skew > now) {
    throw new TokenError("Token is not valid yet", "not_yet_valid");
  }
  if (!claims.sub) {
    throw new TokenError("Token has no subject", "no_subject");
  }

  return claims;
}

// ------------------------------------------------------------------ recovery

/**
 * One-time recovery codes.
 *
 * Email reset is the familiar path, but it makes the mail provider the root of
 * account security — lose the address and the account is gone. These are the
 * way back for someone who no longer controls their email.
 *
 * Stored as hashes: a database leak must not hand over working recovery codes.
 * Each is single-use, and consuming one removes it.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const RECOVERY_GROUPS = 3;
const RECOVERY_GROUP_LENGTH = 4;

export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH);
  const chars = Array.from(bytes, byte => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]);

  const groups: string[] = [];
  for (let i = 0; i < RECOVERY_GROUPS; i++) {
    groups.push(chars.slice(i * RECOVERY_GROUP_LENGTH, (i + 1) * RECOVERY_GROUP_LENGTH).join(""));
  }
  return groups.join("-");
}

export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, generateRecoveryCode);
}

/**
 * Normalise before comparing, so a code works however it was written down —
 * lowercase, spaces instead of dashes, an O that should have been a zero.
 */
export function normalizeRecoveryCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/I/g, "1");
}

/** Compare a candidate against stored hashes without leaking timing. */
export function recoveryCodeMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashRecoveryCode(candidate), "hex");
  const b = Buffer.from(storedHash, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Recovery codes are high-entropy random strings, not user-chosen passwords,
 * so a fast hash is appropriate — there is nothing to brute-force in the way
 * a password needs protecting from.
 */
export function hashRecoveryCode(code: string): string {
  const normalized = normalizeRecoveryCode(code);
  return createHash("sha256").update(`sovrgnnet:recovery:${normalized}`).digest("hex");
}

/**
 * Consume a code, returning the remaining hashes if it matched.
 *
 * Returning a new list rather than mutating makes the single-use property the
 * caller's to persist, and impossible to forget silently.
 */
export function consumeRecoveryCode(
  candidate: string,
  storedHashes: string[]
): { ok: boolean; remaining: string[] } {
  const match = storedHashes.find(hash => recoveryCodeMatches(candidate, hash));
  if (!match) return { ok: false, remaining: storedHashes };
  return { ok: true, remaining: storedHashes.filter(hash => hash !== match) };
}
