/**
 * Signing in to sovrgnnet.cc from the desktop app.
 *
 * Uses Web Crypto rather than `node:crypto`, deliberately: this module is
 * imported by the desktop frontend, which runs in a webview where `node:`
 * builtins do not exist. `crypto.getRandomValues` is a global in browsers and
 * in Node 19+, so the same code runs on both sides.
 *
 * ## Why not the redirect flow the web uses
 *
 * A server sends someone to `/authorize?return=<its own URL>` and gets a token
 * back in the fragment. That works because the destination is a web origin the
 * provider can verify by fetching `/api/instance` from it.
 *
 * A desktop app has no such origin. Returning to `sovrgn://…` would mean
 * handing a bearer token to whichever application happens to have registered
 * that scheme — and on every desktop platform, scheme registration is
 * first-come or last-write, not authenticated. A malicious app installed
 * afterwards could quietly receive somebody's sign-in.
 *
 * So the desktop uses the device flow instead: the app asks for a code, shows
 * it, the person confirms it in their own browser, and the app *polls* for the
 * result. Nothing sensitive travels through a URL anyone else can claim, and
 * the code is useless without someone approving it while signed in.
 */

/** Deliberately short — an unapproved code is a small window of exposure. */
export const DEVICE_CODE_TTL_SECONDS = 600;
export const DEVICE_POLL_INTERVAL_SECONDS = 5;

/** Unambiguous when read aloud or copied by hand: no I, O, 0, or 1. */
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type DeviceAuthorization = {
  /** Secret the app keeps and polls with. Never shown to anyone. */
  deviceCode: string;
  /** Short code the person reads off the screen and types in a browser. */
  userCode: string;
  /** Where to go to approve it. */
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
};

export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow-down"; intervalSeconds: number }
  | { status: "approved"; sessionToken: string }
  | { status: "denied" }
  | { status: "expired" };

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64url(bytes: Uint8Array): string {
  // Indexed rather than for..of: the server build targets an older ES level
  // where iterating a typed array needs downlevelIteration.
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generateDeviceCode(): string {
  return base64url(randomBytes(32));
}

/**
 * A code someone will read off one screen and type into another.
 *
 * Grouped and short for that reason — a 32-character string would be
 * transcribed wrong most of the time.
 */
export function generateUserCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, b => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

/** Accept it however it was typed: lowercase, spaced, or without the dash. */
export function normalizeUserCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/I/g, "1");
}

export function userCodesMatch(a: string, b: string): boolean {
  const left = normalizeUserCode(a);
  return left.length > 0 && left === normalizeUserCode(b);
}

/**
 * What the app should do next, given how the provider answered.
 *
 * `slow-down` is honoured rather than ignored: polling faster than asked is
 * how a client gets rate-limited into failing entirely.
 */
export function interpretPollResponse(
  status: number,
  body: { error?: unknown; session_token?: unknown; interval?: unknown } | null,
  currentInterval: number
): DevicePollResult {
  if (status === 200 && typeof body?.session_token === "string") {
    return { status: "approved", sessionToken: body.session_token };
  }

  switch (body?.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return {
        status: "slow-down",
        intervalSeconds:
          typeof body.interval === "number" ? body.interval : currentInterval + 5,
      };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      // An unrecognised error is treated as still pending rather than fatal:
      // giving up on a transient blip would strand someone mid-sign-in.
      return { status: "pending" };
  }
}

export function isExpired(auth: Pick<DeviceAuthorization, "expiresAt">, now = Date.now()): boolean {
  return now >= auth.expiresAt;
}

/** Human-readable countdown for the waiting screen. */
export function remainingSeconds(
  auth: Pick<DeviceAuthorization, "expiresAt">,
  now = Date.now()
): number {
  return Math.max(0, Math.ceil((auth.expiresAt - now) / 1000));
}
