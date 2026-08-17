import { describe, expect, it } from "vitest";
import {
  generateOpaqueToken,
  generateSubject,
  hashOpaqueToken,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from "./accounts";

/**
 * Passwords, subjects and opaque tokens.
 *
 * Small functions, and the ones where a quiet mistake is worst: a password
 * check that returns true too easily, a subject that changes when it must not,
 * a session token stored in a form that a database leak turns into a login.
 */

describe("passwords", () => {
  it("accepts the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    // Without a per-password salt, identical passwords produce identical
    // hashes and the database tells an attacker which accounts to try first.
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  it("returns false rather than throwing on a malformed record", async () => {
    // A row that predates this format, or one that was truncated, must fail
    // the login. Throwing would turn it into a 500 and — depending on where
    // it is caught — potentially into something that isn't a rejection.
    for (const broken of ["", ":", "nosalt", "deadbeef:", ":deadbeef", "a:b:c"]) {
      expect(await verifyPassword("anything", broken)).toBe(false);
    }
  });

  it("rejects a hash of the wrong length without comparing it", async () => {
    // timingSafeEqual throws on length mismatch, so the guard before it is
    // load-bearing rather than defensive: without it, a short stored hash is
    // an exception instead of a failed login.
    expect(await verifyPassword("x", `${"aa".repeat(16)}:beef`)).toBe(false);
  });

  it("does not care how long the password is", async () => {
    const long = "x".repeat(4096);
    expect(await verifyPassword(long, await hashPassword(long))).toBe(true);
  });
});

describe("subjects", () => {
  it("is unique across many draws", () => {
    // Every server on the network keys its local account off this value. A
    // collision does not look like an error; it looks like two people being
    // the same person, everywhere at once.
    const seen = new Set(Array.from({ length: 5_000 }, () => generateSubject()));
    expect(seen.size).toBe(5_000);
  });

  it("is random rather than derived from anything", () => {
    // Deriving it from the email would mean an address change silently made
    // someone a stranger on every server they had ever joined.
    expect(generateSubject()).not.toBe(generateSubject());
    expect(generateSubject()).toMatch(/^acct_[0-9a-f]{32}$/);
  });
});

describe("opaque tokens", () => {
  it("stores a hash, not the token", () => {
    // The plaintext lives in a cookie or an emailed link and nowhere else.
    // A database leak should not be a leak of working sessions.
    const { token, hash } = generateOpaqueToken();
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes deterministically, so a presented token can be looked up", () => {
    const { token, hash } = generateOpaqueToken();
    expect(hashOpaqueToken(token)).toBe(hash);
  });

  it("is unique across many draws", () => {
    const seen = new Set(Array.from({ length: 5_000 }, () => generateOpaqueToken().token));
    expect(seen.size).toBe(5_000);
  });

  it("is url-safe, because it travels in links", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generateOpaqueToken().token).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});

describe("email normalization", () => {
  it("folds case and trims, the way people type", () => {
    expect(normalizeEmail("  Zach@Example.COM ")).toBe("zach@example.com");
  });

  it("is idempotent", () => {
    // Applied on write and again on lookup. If a second pass changed the
    // value, an account would become unfindable by the address it was
    // created with.
    const once = normalizeEmail(" Someone@Example.com ");
    expect(normalizeEmail(once)).toBe(once);
  });

  it("does not strip dots or plus-addressing", () => {
    // Tempting, and wrong: those rules are Gmail's, not the internet's.
    // a.b@example.com and ab@example.com are different mailboxes at most
    // providers, and treating them as one is an account takeover.
    expect(normalizeEmail("a.b+tag@example.com")).toBe("a.b+tag@example.com");
  });
});
