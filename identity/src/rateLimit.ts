import type { NextFunction, Request, Response } from "express";

/**
 * Rate limiting for the identity service.
 *
 * Every endpoint here was unbounded, and they are the ones that most need not
 * to be. Three different costs, all payable by anyone who can reach the port:
 *
 * - **Guessing.** Sign-in, and recovery in particular: a recovery code is
 *   short enough to be worth trying, and spending one is a password reset.
 * - **CPU.** scrypt is deliberately expensive, which makes registration, login
 *   and recovery into an amplifier — a few hundred concurrent requests can
 *   saturate a small VPS with work it asked for.
 * - **Rows.** Registration and device-code creation both write, so an
 *   unbounded caller fills a database the operator pays for.
 *
 * In-process and per-instance, matching the main app's login limiter. That is
 * a real limitation and it is the honest one to ship: the identity service is
 * a single process today, and a Redis dependency to make the counter shared
 * would be infrastructure added for a deployment shape that doesn't exist yet.
 * If it ever runs behind more than one process, this becomes per-process and
 * the limits multiply — written here so that discovery is a reading, not a
 * surprise.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Swept on write rather than on a timer.
 *
 * An interval would keep the process alive and would need clearing in tests;
 * this costs a scan only when the map has grown, and the map only grows under
 * exactly the traffic the limiter is for.
 */
const SWEEP_THRESHOLD = 10_000;

function sweep(now: number): void {
  for (const [key, bucket] of Array.from(buckets.entries())) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}

export interface LimitOptions {
  /** How many requests are allowed in the window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Distinguishes one limiter's counters from another's. */
  name: string;
}

export function consume(
  key: string,
  opts: LimitOptions
): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  if (buckets.size > SWEEP_THRESHOLD) sweep(now);

  const composite = `${opts.name}:${key}`;
  const bucket = buckets.get(composite);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(composite, { count: 1, resetAt: now + opts.windowMs });
    return { ok: true, retryAfterMs: 0 };
  }

  bucket.count += 1;
  if (bucket.count <= opts.max) return { ok: true, retryAfterMs: 0 };
  return { ok: false, retryAfterMs: Math.max(0, bucket.resetAt - now) };
}

/** Test seam — the counters are process-global and outlive a single test. */
export function __resetRateLimits(): void {
  buckets.clear();
}

/**
 * The caller's address.
 *
 * `req.ip` is only trustworthy when Express has been told which proxies to
 * trust; behind an untrusted one every request looks like it comes from the
 * proxy and the whole service shares one bucket. That is the safe direction to
 * be wrong in — it over-limits rather than under-limits — but it is worth
 * knowing, so `trust proxy` is set explicitly where the app is created.
 */
function callerKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

/**
 * Limit by address, and optionally by something in the body as well.
 *
 * The second key matters for guessing: limiting a login endpoint purely by
 * address lets one attacker with a botnet try one password on ten thousand
 * accounts. Limiting by the *account* too bounds what any number of addresses
 * can do to one person.
 */
export function rateLimit(
  opts: LimitOptions & { alsoKeyOn?: (req: Request) => string | null }
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const keys = [callerKey(req)];
    const extra = opts.alsoKeyOn?.(req);
    if (extra) keys.push(`subject:${extra}`);

    for (const key of keys) {
      const verdict = consume(key, opts);
      if (!verdict.ok) {
        const seconds = Math.ceil(verdict.retryAfterMs / 1000);
        res.set("Retry-After", String(seconds));
        // 429 with a plain sentence. The count and the window are deliberately
        // not disclosed: they'd tell someone tuning an attack exactly how slow
        // to go.
        res.status(429).json({
          error: `Too many attempts. Try again in ${seconds > 60 ? `${Math.ceil(seconds / 60)} minutes` : `${seconds} seconds`}.`,
        });
        return;
      }
    }

    next();
  };
}

/** Lowercased email from the body, for limiters that should bound per-account. */
export function emailFromBody(req: Request): string | null {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === "string" && email
    ? email.toLowerCase().slice(0, 320)
    : null;
}

/**
 * The limits themselves, in one place so they can be read as a policy rather
 * than found one route at a time.
 *
 * Numbers chosen to be invisible to a person and ruinous to a script. Nobody
 * legitimately registers five accounts an hour from one address, or enters ten
 * recovery codes in fifteen minutes; both are generous next to what the attack
 * needs.
 */
export const LIMITS = {
  /** Writes a row and runs scrypt. */
  register: { name: "register", max: 5, windowMs: 60 * 60 * 1000 },
  /** Runs scrypt, and is the obvious guessing target. */
  signIn: { name: "signIn", max: 10, windowMs: 15 * 60 * 1000 },
  /** Runs scrypt *and* spends a code that resets a password. */
  recover: { name: "recover", max: 10, windowMs: 15 * 60 * 1000 },
  /** Sends mail, so an abuser spends the operator's reputation, not just CPU. */
  resetRequest: { name: "resetRequest", max: 5, windowMs: 60 * 60 * 1000 },
  /** Writes a row per call, with no authentication at all. */
  deviceCode: { name: "deviceCode", max: 20, windowMs: 60 * 60 * 1000 },
  /** Guessing a short user code; polling is limited separately by interval. */
  deviceApprove: { name: "deviceApprove", max: 20, windowMs: 15 * 60 * 1000 },
} as const;
