import type { Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIMITS,
  __resetRateLimits,
  consume,
  emailFromBody,
  rateLimit,
} from "./rateLimit";

/**
 * The limiter in front of every expensive or guessable endpoint here.
 *
 * Worth testing directly rather than through routes: the properties that
 * matter are about counting and key separation, and both fail silently. A
 * limiter that shares a counter across endpoints throttles honest traffic; one
 * that keys too broadly stops guessing at the cost of locking out a whole
 * office behind one NAT; one that keys too narrowly stops nothing at all.
 */

afterEach(() => {
  __resetRateLimits();
  vi.useRealTimers();
});

describe("counting", () => {
  it("allows exactly max, then refuses", () => {
    const opts = { name: "t", max: 3, windowMs: 1000 };
    expect(consume("a", opts).ok).toBe(true);
    expect(consume("a", opts).ok).toBe(true);
    expect(consume("a", opts).ok).toBe(true);
    expect(consume("a", opts).ok).toBe(false);
  });

  it("tells the caller how long to wait", () => {
    const opts = { name: "t", max: 1, windowMs: 60_000 };
    consume("a", opts);
    const verdict = consume("a", opts);
    expect(verdict.ok).toBe(false);
    expect(verdict.retryAfterMs).toBeGreaterThan(0);
    expect(verdict.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it("forgets once the window passes", () => {
    vi.useFakeTimers();
    const opts = { name: "t", max: 1, windowMs: 1000 };
    expect(consume("a", opts).ok).toBe(true);
    expect(consume("a", opts).ok).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(consume("a", opts).ok).toBe(true);
  });
});

describe("key separation", () => {
  it("counts different callers separately", () => {
    const opts = { name: "t", max: 1, windowMs: 1000 };
    expect(consume("a", opts).ok).toBe(true);
    expect(consume("b", opts).ok).toBe(true);
  });

  it("counts different limiters separately", () => {
    // Same caller, two endpoints. Without the name in the composite key,
    // signing in would eat the budget for registering — a user hitting a
    // limit on an endpoint they never touched.
    const key = "1.2.3.4";
    expect(consume(key, { name: "signIn", max: 1, windowMs: 1000 }).ok).toBe(true);
    expect(consume(key, { name: "register", max: 1, windowMs: 1000 }).ok).toBe(true);
  });
});

function fakeReq(ip: string, body: unknown = {}): Request {
  return { ip, body, headers: {}, socket: { remoteAddress: ip } } as unknown as Request;
}

function fakeRes(): Response & { statusCode?: number; payload?: unknown; headers: Record<string, string> } {
  const res = {
    headers: {} as Record<string, string>,
    statusCode: undefined as number | undefined,
    payload: undefined as unknown,
    set(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.payload = body;
      return res;
    },
  };
  return res as never;
}

describe("the middleware", () => {
  it("passes the request through under the limit", () => {
    const middleware = rateLimit({ name: "t", max: 2, windowMs: 1000 });
    const next = vi.fn();
    middleware(fakeReq("1.1.1.1"), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("answers 429 with Retry-After instead of calling next", () => {
    const middleware = rateLimit({ name: "t", max: 1, windowMs: 60_000 });
    const next = vi.fn();
    middleware(fakeReq("1.1.1.1"), fakeRes(), next);

    const res = fakeRes();
    middleware(fakeReq("1.1.1.1"), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(429);
    expect(res.headers["Retry-After"]).toBeDefined();
  });

  it("does not disclose the limit or the window", () => {
    // Both would tell someone tuning an attack exactly how slow to go.
    const middleware = rateLimit({ name: "t", max: 1, windowMs: 60_000 });
    middleware(fakeReq("1.1.1.1"), fakeRes(), vi.fn());
    const res = fakeRes();
    middleware(fakeReq("1.1.1.1"), res, vi.fn());

    const message = JSON.stringify(res.payload);
    expect(message).not.toMatch(/\b1\b.*attempts? allowed/);
    expect(message).toMatch(/Too many attempts/);
  });

  it("bounds what many addresses can do to one account", () => {
    // The reason alsoKeyOn exists. Limiting a login endpoint by address alone
    // lets a botnet try one password against ten thousand accounts, each
    // address staying comfortably under its own limit.
    const middleware = rateLimit({
      name: "signIn",
      max: 5,
      windowMs: 60_000,
      alsoKeyOn: emailFromBody,
    });

    const victim = { email: "target@example.com" };
    let refusals = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = fakeRes();
      // A different address every time — the botnet case.
      middleware(fakeReq(`10.0.0.${i}`, victim), res, vi.fn());
      if (res.statusCode === 429) refusals += 1;
    }
    expect(refusals).toBeGreaterThan(0);
  });
});

describe("emailFromBody", () => {
  it("lowercases, so casing cannot be used to get a fresh budget", () => {
    expect(emailFromBody(fakeReq("1.1.1.1", { email: "Zach@Example.com" }))).toBe(
      "zach@example.com"
    );
  });

  it("returns null when there is nothing usable", () => {
    for (const body of [{}, { email: "" }, { email: 42 }, undefined]) {
      expect(emailFromBody(fakeReq("1.1.1.1", body))).toBeNull();
    }
  });

  it("caps the length, so the body cannot grow the key map", () => {
    // The key becomes a map entry. Without a cap, one caller posting megabyte
    // "emails" turns the limiter into the memory leak.
    const key = emailFromBody(fakeReq("1.1.1.1", { email: "x".repeat(10_000) }));
    expect(key).not.toBeNull();
    expect(key!.length).toBeLessThanOrEqual(320);
  });
});

describe("the published limits", () => {
  it("gives every endpoint its own name", () => {
    // A duplicated name silently merges two endpoints' budgets.
    const names = Object.values(LIMITS).map((l) => l.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every limit finite and positive", () => {
    for (const [endpoint, limit] of Object.entries(LIMITS)) {
      expect(limit.max, endpoint).toBeGreaterThan(0);
      expect(limit.max, endpoint).toBeLessThan(1000);
      expect(limit.windowMs, endpoint).toBeGreaterThan(0);
    }
  });

  it("is strictest where a success is most costly", () => {
    // recover spends a code that resets a password; register writes a row and
    // runs scrypt. Neither should ever be looser than plain sign-in.
    expect(LIMITS.recover.max).toBeLessThanOrEqual(LIMITS.signIn.max);
    expect(LIMITS.register.max).toBeLessThanOrEqual(LIMITS.signIn.max);
  });
});
