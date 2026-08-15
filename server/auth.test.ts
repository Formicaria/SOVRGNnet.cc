import { beforeAll, describe, expect, it } from "vitest";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-auth-tests";

import {
  checkLoginRateLimit,
  createSessionToken,
  hashPassword,
  resetLoginRateLimit,
  verifyPassword,
  verifySessionToken,
} from "./_core/auth";

describe("Password hashing", () => {
  it("hashes and verifies a correct password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt:")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Tr0ub4dor&3", hash)).toBe(false);
  });

  it("produces unique salts per hash", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
  });

  it("rejects malformed stored hashes without throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });
});

describe("Session tokens", () => {
  it("round-trips a user id", async () => {
    const token = await createSessionToken(42);
    expect(await verifySessionToken(token)).toBe(42);
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken(42);
    const tampered = token.slice(0, -4) + "AAAA";
    expect(await verifySessionToken(tampered)).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(await verifySessionToken("garbage.token.here")).toBeNull();
  });
});

describe("Login rate limiting", () => {
  it("allows up to the limit then blocks", () => {
    const key = `test:${Date.now()}`;
    for (let i = 0; i < 10; i++) {
      expect(checkLoginRateLimit(key)).toBe(true);
    }
    expect(checkLoginRateLimit(key)).toBe(false);
  });

  it("reset clears the counter", () => {
    const key = `test-reset:${Date.now()}`;
    for (let i = 0; i < 11; i++) checkLoginRateLimit(key);
    expect(checkLoginRateLimit(key)).toBe(false);
    resetLoginRateLimit(key);
    expect(checkLoginRateLimit(key)).toBe(true);
  });
});
