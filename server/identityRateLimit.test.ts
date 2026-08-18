import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetRateLimits,
  consume,
  emailFromBody,
  LIMITS,
} from "../identity/src/rateLimit";

/**
 * The identity service's rate limits.
 *
 * Every endpoint there was unbounded, which made registration, sign-in and
 * recovery into three separate ways to spend somebody else's CPU on scrypt,
 * and made recovery-code guessing free. These cover the counter itself and —
 * because a limiter nobody applied is a limiter that doesn't exist — that the
 * routes actually use it.
 */

beforeEach(() => __resetRateLimits());

const LIMIT = { name: "test", max: 3, windowMs: 60_000 };

describe("the counter", () => {
  it("allows up to the limit and refuses after it", () => {
    for (let i = 0; i < LIMIT.max; i++) {
      expect(consume("a", LIMIT).ok, `request ${i + 1} should pass`).toBe(true);
    }
    expect(consume("a", LIMIT).ok).toBe(false);
  });

  it("counts each key separately", () => {
    for (let i = 0; i < LIMIT.max; i++) consume("a", LIMIT);
    // One caller exhausting their allowance must not lock out everyone else,
    // which is the failure mode of a single global counter.
    expect(consume("b", LIMIT).ok).toBe(true);
  });

  it("counts each limiter separately", () => {
    for (let i = 0; i < LIMIT.max; i++) consume("a", LIMIT);
    // Same caller, different endpoint. Sharing a bucket across endpoints would
    // let a burst of cheap requests lock someone out of signing in.
    expect(consume("a", { ...LIMIT, name: "other" }).ok).toBe(true);
  });

  it("says how long to wait, and doesn't lie about it", () => {
    for (let i = 0; i < LIMIT.max; i++) consume("a", LIMIT);
    const refused = consume("a", LIMIT);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterMs).toBeGreaterThan(0);
    expect(refused.retryAfterMs).toBeLessThanOrEqual(LIMIT.windowMs);
  });

  it("forgets a caller once their window has passed", () => {
    const brief = { name: "brief", max: 1, windowMs: 1 };
    expect(consume("a", brief).ok).toBe(true);
    expect(consume("a", brief).ok).toBe(false);
    // A limiter that never forgets is a permanent ban after one bad minute.
    const later = Date.now() + 5;
    while (Date.now() < later) {
      /* spin briefly; the window is 1ms */
    }
    expect(consume("a", brief).ok).toBe(true);
  });
});

describe("keying on the account as well as the address", () => {
  it("reads an email out of the body, lowercased", () => {
    expect(
      emailFromBody({ body: { email: "Zach@Example.COM" } } as never)
    ).toBe("zach@example.com");
  });

  it.each([
    [{}, "no body field"],
    [{ email: "" }, "an empty email"],
    [{ email: 42 }, "a non-string"],
    [undefined, "no body at all"],
  ])("returns null for %j — %s", (body, _why) => {
    expect(emailFromBody({ body } as never)).toBeNull();
  });
});

describe("the limits are set to numbers that mean something", () => {
  it("bounds every endpoint that runs scrypt or writes a row", () => {
    for (const [name, limit] of Object.entries(LIMITS)) {
      expect(limit.max, `${name} has no ceiling`).toBeGreaterThan(0);
      expect(limit.max, `${name} is too loose to matter`).toBeLessThanOrEqual(
        50
      );
      expect(
        limit.windowMs,
        `${name} has too short a window`
      ).toBeGreaterThanOrEqual(60_000);
    }
  });

  it("is strictest where a success is most valuable", () => {
    // Spending a recovery code resets a password. It should not be easier to
    // guess than a password is to try.
    expect(LIMITS.recover.max).toBeLessThanOrEqual(LIMITS.signIn.max);
    // Registration writes a row and hashes a password; device codes only write.
    expect(LIMITS.register.max).toBeLessThanOrEqual(LIMITS.deviceCode.max);
  });
});

describe("the routes actually apply them", () => {
  const routes = readFileSync(
    join(__dirname, "..", "identity", "src", "routes.ts"),
    "utf8"
  );

  it.each([
    ["/api/register", "LIMITS.register"],
    ["/api/login", "LIMITS.signIn"],
    ["/api/recover", "LIMITS.recover"],
    ["/api/reset/request", "LIMITS.resetRequest"],
    ["/api/reset/complete", "LIMITS.recover"],
    ["/api/device/code", "LIMITS.deviceCode"],
    ["/api/device/approve", "LIMITS.deviceApprove"],
  ])("%s is behind %s", (route, limit) => {
    // Anchored on the *registration* — `app.post("/api/…"` — not on any
    // mention of the path. The first version searched for the bare string, and
    // broke when a CORS middleware was added with `app.use([...paths])` above
    // the routes: it found that list, looked 260 characters past it, saw no
    // rateLimit, and reported a missing limit on a route that had one.
    //
    // A guard that matches text rather than structure eventually points at the
    // wrong line, and the report it gives is confident and false.
    const registration = new RegExp(
      `app\\.(?:get|post|put|patch|delete)\\(\\s*\n?\\s*"${route.replace(/\//g, "\\/")}"`
    );
    const found = registration.exec(routes);
    expect(found, `${route} is never registered`).not.toBeNull();
    const at = found!.index;
    const declaration = routes.slice(at, at + 260);
    expect(declaration, `${route} has no rate limit`).toContain("rateLimit(");
    expect(declaration).toContain(limit);
  });

  it("keys the guessable endpoints on the account too", () => {
    // Address-only limiting lets a botnet try one password against ten
    // thousand accounts without any single address hitting a ceiling.
    for (const route of ["/api/login", "/api/recover"]) {
      const at = routes.indexOf(`"${route}"`);
      expect(routes.slice(at, at + 260)).toContain("emailFromBody");
    }
  });
});
