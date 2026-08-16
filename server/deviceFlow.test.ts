import { describe, expect, it } from "vitest";
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  generateDeviceCode,
  generateUserCode,
  interpretPollResponse,
  isExpired,
  normalizeUserCode,
  remainingSeconds,
  userCodesMatch,
} from "@shared/deviceFlow";

describe("device codes", () => {
  it("are long and unguessable", () => {
    const codes = new Set(Array.from({ length: 50 }, generateDeviceCode));
    expect(codes.size).toBe(50);
    expect(generateDeviceCode().length).toBeGreaterThan(30);
  });

  it("are URL-safe, since they travel in request bodies and logs", () => {
    expect(generateDeviceCode()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("user codes", () => {
  it("are short and grouped, because a person types them", () => {
    expect(generateUserCode()).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  });

  it("avoid characters people misread", () => {
    // Someone reads this off one screen and types it into another; I/1 and
    // O/0 are where that goes wrong.
    const many = Array.from({ length: 60 }, generateUserCode).join("");
    expect(many).not.toMatch(/[IO01]/);
  });

  it("are different every time", () => {
    expect(new Set(Array.from({ length: 40 }, generateUserCode)).size).toBe(40);
  });

  describe("matching what someone typed", () => {
    it("accepts the exact code", () => {
      expect(userCodesMatch("ABCD-EFGH", "ABCD-EFGH")).toBe(true);
    });

    it("accepts it lowercase, spaced, or without the dash", () => {
      for (const typed of ["abcd-efgh", "ABCD EFGH", "abcdefgh", " ABCD-EFGH "]) {
        expect(userCodesMatch(typed, "ABCD-EFGH")).toBe(true);
      }
    });

    it("forgives an O typed for a zero", () => {
      expect(normalizeUserCode("ABCO")).toBe(normalizeUserCode("ABC0"));
      expect(normalizeUserCode("ABCI")).toBe(normalizeUserCode("ABC1"));
    });

    it("rejects a different code", () => {
      expect(userCodesMatch("ABCD-EFGH", "ABCD-EFGX")).toBe(false);
    });

    it("rejects empty input rather than matching everything", () => {
      // Without the length guard, "" would normalise to "" and match "".
      expect(userCodesMatch("", "")).toBe(false);
      expect(userCodesMatch("---", "ABCD-EFGH")).toBe(false);
    });
  });
});

describe("interpretPollResponse", () => {
  const interval = DEVICE_POLL_INTERVAL_SECONDS;

  it("reads an approval", () => {
    expect(interpretPollResponse(200, { session_token: "sess_abc" }, interval)).toEqual({
      status: "approved",
      sessionToken: "sess_abc",
    });
  });

  it("keeps waiting while nobody has approved yet", () => {
    expect(
      interpretPollResponse(400, { error: "authorization_pending" }, interval)
    ).toEqual({ status: "pending" });
  });

  it("backs off when told to", () => {
    // Polling faster than asked is how a client gets rate-limited into
    // failing outright.
    expect(interpretPollResponse(400, { error: "slow_down", interval: 15 }, interval)).toEqual(
      { status: "slow-down", intervalSeconds: 15 }
    );
  });

  it("backs off by a sensible amount when no interval is given", () => {
    const result = interpretPollResponse(400, { error: "slow_down" }, 5);
    expect(result).toMatchObject({ status: "slow-down" });
    if (result.status !== "slow-down") throw new Error("expected slow-down");
    expect(result.intervalSeconds).toBeGreaterThan(5);
  });

  it("stops on an explicit refusal", () => {
    expect(interpretPollResponse(400, { error: "access_denied" }, interval)).toEqual({
      status: "denied",
    });
  });

  it("stops when the code has expired", () => {
    expect(interpretPollResponse(400, { error: "expired_token" }, interval)).toEqual({
      status: "expired",
    });
  });

  it("keeps waiting through an unrecognised error", () => {
    // Giving up on a transient blip would strand someone mid-sign-in with no
    // way forward but starting over.
    expect(interpretPollResponse(500, null, interval)).toEqual({ status: "pending" });
    expect(interpretPollResponse(400, { error: "something_new" }, interval)).toEqual({
      status: "pending",
    });
  });

  it("doesn't treat a 200 without a token as approval", () => {
    expect(interpretPollResponse(200, {}, interval)).toEqual({ status: "pending" });
    expect(interpretPollResponse(200, { session_token: 42 } as never, interval)).toEqual({
      status: "pending",
    });
  });
});

describe("expiry", () => {
  const now = 1_000_000;

  it("is not expired before the deadline", () => {
    expect(isExpired({ expiresAt: now + 1000 }, now)).toBe(false);
  });

  it("is expired at and after the deadline", () => {
    expect(isExpired({ expiresAt: now }, now)).toBe(true);
    expect(isExpired({ expiresAt: now - 1 }, now)).toBe(true);
  });

  it("counts down in whole seconds", () => {
    expect(remainingSeconds({ expiresAt: now + 30_000 }, now)).toBe(30);
    expect(remainingSeconds({ expiresAt: now + 1500 }, now)).toBe(2);
  });

  it("never counts below zero", () => {
    expect(remainingSeconds({ expiresAt: now - 99_000 }, now)).toBe(0);
  });
});
