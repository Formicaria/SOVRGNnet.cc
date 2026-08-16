import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canRegister, instanceInfo, instanceId, normalizeJoinPolicy } from "./instance";

const ENV_KEYS = [
  "INSTANCE_NAME",
  "INSTANCE_DESCRIPTION",
  "INSTANCE_JOIN_POLICY",
  "INSTANCE_LISTED",
  "MATRIX_PUBLIC_URL",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  ENV_KEYS.forEach(k => delete process.env[k]);
});

afterEach(() => {
  ENV_KEYS.forEach(k => {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  });
});

describe("normalizeJoinPolicy", () => {
  it("accepts the three real values", () => {
    expect(normalizeJoinPolicy("open")).toBe("open");
    expect(normalizeJoinPolicy("closed")).toBe("closed");
    expect(normalizeJoinPolicy("invite")).toBe("invite");
  });

  it("is case-insensitive", () => {
    expect(normalizeJoinPolicy("OPEN")).toBe("open");
  });

  it("falls back to invite-only for anything unrecognised", () => {
    // The safe default: an unreadable setting must never mean "open".
    expect(normalizeJoinPolicy("nonsense")).toBe("invite");
    expect(normalizeJoinPolicy(null)).toBe("invite");
    expect(normalizeJoinPolicy(undefined)).toBe("invite");
    expect(normalizeJoinPolicy("")).toBe("invite");
  });
});

describe("instanceInfo", () => {
  it("identifies itself as SOVRGNnet", () => {
    const info = instanceInfo("0.1.0");
    expect(info.product).toBe("sovrgnnet");
    expect(info.apiVersion).toBe(1);
    expect(info.software).toEqual({ name: "sovrgnnet", version: "0.1.0" });
  });

  it("defaults to invite-only and unlisted", () => {
    const info = instanceInfo("0.1.0");
    expect(info.joinPolicy).toBe("invite");
    expect(info.listed).toBe(false);
  });

  it("never claims encryption, because this build has none", () => {
    expect(instanceInfo("0.1.0").encryption).toBe(false);
  });

  it("does not start claiming encryption once the homeserver is public", () => {
    // A reachable homeserver is a precondition for clients to sync directly,
    // and therefore for encryption to become possible later. It is not
    // encryption. These two must never be wired together again.
    process.env.MATRIX_PUBLIC_URL = "https://matrix.example.com";

    const info = instanceInfo("0.1.0");
    expect(info.matrixBaseUrl).toBe("https://matrix.example.com");
    expect(info.encryption).toBe(false);
  });

  it("exposes the homeserver address so clients know direct sync is possible", () => {
    expect(instanceInfo("0.1.0").matrixBaseUrl).toBeNull();

    process.env.MATRIX_PUBLIC_URL = "https://matrix.example.com";
    expect(instanceInfo("0.1.0").matrixBaseUrl).toBe("https://matrix.example.com");
  });

  describe("settings precedence", () => {
    it("uses the environment when nothing is stored", () => {
      process.env.INSTANCE_NAME = "From env";
      process.env.INSTANCE_JOIN_POLICY = "open";
      process.env.INSTANCE_LISTED = "true";

      const info = instanceInfo("0.1.0");
      expect(info.name).toBe("From env");
      expect(info.joinPolicy).toBe("open");
      expect(info.listed).toBe(true);
    });

    it("lets stored settings override the environment", () => {
      // The whole point: an admin editing settings in the client must beat
      // whatever was baked into .env at install time.
      process.env.INSTANCE_NAME = "From env";
      process.env.INSTANCE_JOIN_POLICY = "open";
      process.env.INSTANCE_LISTED = "true";

      const info = instanceInfo("0.1.0", {
        name: "From the client",
        description: "Set by an admin",
        joinPolicy: "closed",
        listed: false,
      });

      expect(info.name).toBe("From the client");
      expect(info.description).toBe("Set by an admin");
      expect(info.joinPolicy).toBe("closed");
      expect(info.listed).toBe(false);
    });

    it("falls back per-field, not all-or-nothing", () => {
      process.env.INSTANCE_NAME = "From env";
      const info = instanceInfo("0.1.0", { joinPolicy: "closed" });

      expect(info.joinPolicy).toBe("closed");
      expect(info.name).toBe("From env");
    });

    it("treats a stored blank name as unset", () => {
      process.env.INSTANCE_NAME = "From env";
      expect(instanceInfo("0.1.0", { name: "   " }).name).toBe("From env");
    });

    it("respects a stored listed=false over an env opt-in", () => {
      // Directory listing is opt-in and must be revocable from the client.
      process.env.INSTANCE_LISTED = "true";
      expect(instanceInfo("0.1.0", { listed: false }).listed).toBe(false);
    });
  });

  it("never returns an empty name", () => {
    expect(instanceInfo("0.1.0").name.length).toBeGreaterThan(0);
  });
});

describe("canRegister", () => {
  describe("the very first account", () => {
    // The bootstrap case. A fresh install defaults to invite-only, so without
    // this exception the owner would need an invite to a community that does
    // not exist yet — the server could never be set up at all.
    it("is allowed no matter what the policy says", () => {
      for (const policy of ["open", "invite", "closed"] as const) {
        expect(
          canRegister({ policy, isFirstAccount: true, hasValidInvite: false })
        ).toEqual({ allowed: true, reason: "bootstrap" });
      }
    });
  });

  describe("open", () => {
    it("lets anyone in", () => {
      expect(
        canRegister({ policy: "open", isFirstAccount: false, hasValidInvite: false })
      ).toMatchObject({ allowed: true });
    });
  });

  describe("invite", () => {
    it("accepts someone holding a valid invite", () => {
      expect(
        canRegister({ policy: "invite", isFirstAccount: false, hasValidInvite: true })
      ).toEqual({ allowed: true, reason: "invite" });
    });

    it("turns away someone without one", () => {
      const verdict = canRegister({
        policy: "invite",
        isFirstAccount: false,
        hasValidInvite: false,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict).toHaveProperty("message", expect.stringMatching(/invite/i));
    });
  });

  describe("closed", () => {
    it("turns everyone away", () => {
      expect(
        canRegister({ policy: "closed", isFirstAccount: false, hasValidInvite: false })
      ).toMatchObject({ allowed: false });
    });

    it("turns away even someone holding a valid invite", () => {
      // Closed means closed. An old invite link shouldn't reopen a server the
      // owner deliberately shut.
      expect(
        canRegister({ policy: "closed", isFirstAccount: false, hasValidInvite: true })
      ).toMatchObject({ allowed: false });
    });
  });

  it("explains itself when refusing", () => {
    for (const policy of ["invite", "closed"] as const) {
      const verdict = canRegister({
        policy,
        isFirstAccount: false,
        hasValidInvite: false,
      });
      if (verdict.allowed) throw new Error("expected a refusal");
      expect(verdict.message.length).toBeGreaterThan(10);
    }
  });
});

describe("instanceId", () => {
  it("is stable and URL-safe", () => {
    expect(instanceId()).toBe(instanceId());
    expect(instanceId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
