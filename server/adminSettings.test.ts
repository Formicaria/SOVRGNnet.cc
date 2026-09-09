import { beforeEach, describe, expect, it, vi } from "vitest";

// ENV is captured when ./routers imports matrixService, and ES module imports
// are hoisted above ordinary statements — so these must be set inside
// vi.hoisted or they land too late to be seen.
vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-admin-settings";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET || "test-shared-secret-for-admin-settings";
});

/**
 * The v0.8 settings surface, at the API boundary.
 *
 * `settings.test.ts` pins the precedence rule; this pins what an admin can do
 * to it over tRPC and — more importantly — what they cannot get back out.
 * Two invariants are worth a test each because both are one careless
 * refactor from breaking: a secret is never returned, and omitting a field
 * is not the same as sending null.
 */
vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    getInstanceSettings: vi.fn(),
    saveInstanceSettings: vi.fn(),
  };
});

import * as db from "./db";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

type AuthenticatedUser = NonNullable<TrpcContext["user"]>;

function callerAs(role: "admin" | "user") {
  const user: AuthenticatedUser = {
    id: 1,
    openId: "user-1",
    username: "operator",
    usernameFold: "operator",
    passwordHash: null,
    ssoSubject: null,
    email: null,
    name: "Operator",
    loginMethod: "local",
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSignedIn: new Date(),
  };
  return appRouter.createCaller({
    user,
    req: { protocol: "https", headers: {}, ip: "127.0.0.1" } as TrpcContext["req"],
    res: { cookie: () => {}, clearCookie: () => {} } as unknown as TrpcContext["res"],
  });
}

/** A stored row with every v0.8 column, secrets included. */
function fullRow() {
  return {
    id: 1,
    name: "Stored name",
    description: null,
    joinPolicy: "invite",
    listed: false,
    federationEnabled: true,
    matrixPublicUrl: "https://matrix.stored.example",
    ssoEnabled: false,
    identityIssuer: null,
    voiceUrl: "wss://voice.stored.example",
    voiceApiKey: "stored-key",
    voiceApiSecret: "STORED-SECRET-VALUE",
    ipfsApiUrl: null,
    metricsToken: "STORED-METRICS-TOKEN",
    readyTimeoutMs: 1234,
    updatedAt: new Date(),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(db.getInstanceSettings).mockResolvedValue(null);
  // Echo the patch back as the saved row, the way an upsert does.
  vi.mocked(db.saveInstanceSettings).mockImplementation(async values => ({
    id: 1,
    name: null,
    description: null,
    joinPolicy: "invite",
    listed: false,
    updatedAt: new Date(),
    ...values,
  }) as never);
});

describe("admin.getSettings", () => {
  it("is admin-only", async () => {
    await expect(callerAs("user").admin.getSettings()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("never returns a secret's value, only whether one is set", async () => {
    vi.mocked(db.getInstanceSettings).mockResolvedValue(fullRow());
    const result = await callerAs("admin").admin.getSettings();

    expect(result.hasVoiceApiSecret).toBe(true);
    expect(result.hasMetricsToken).toBe(true);
    // The serialised response is what leaves the process. Search it whole
    // rather than the two fields we remembered to redact, so a future
    // column that happens to carry a secret trips this too.
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("STORED-SECRET-VALUE");
    expect(wire).not.toContain("STORED-METRICS-TOKEN");
    expect(result).not.toHaveProperty("voiceApiSecret");
    expect(result).not.toHaveProperty("metricsToken");
  });

  it("says where each value comes from", async () => {
    vi.mocked(db.getInstanceSettings).mockResolvedValue(fullRow());
    const result = await callerAs("admin").admin.getSettings();
    expect(result.federationEnabledSource).toBe("stored");
    expect(result.voiceUrlSource).toBe("stored");
    // Null in the row: the environment is answering, whatever it says.
    expect(result.identityIssuerSource).toBe("environment");
    expect(result.ipfsApiUrlSource).toBe("environment");
  });

  it("reports every source as environment for an unconfigured instance", async () => {
    const result = await callerAs("admin").admin.getSettings();
    expect(result.configured).toBe(false);
    for (const key of Object.keys(result).filter(k => k.endsWith("Source"))) {
      expect(result[key as keyof typeof result]).toBe("environment");
    }
  });
});

describe("admin.updateSettings", () => {
  it("is admin-only", async () => {
    await expect(
      callerAs("user").admin.updateSettings({ federationEnabled: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("writes only the fields it was sent — omitted is not null", async () => {
    // The distinction the whole form depends on: a save that touched one
    // switch must not hand every other field back to the environment.
    await callerAs("admin").admin.updateSettings({ federationEnabled: false });
    const [values] = vi.mocked(db.saveInstanceSettings).mock.calls[0];
    expect(values).toEqual({ federationEnabled: false });
    expect(values).not.toHaveProperty("voiceUrl");
    expect(values).not.toHaveProperty("metricsToken");
  });

  it("passes an explicit null through as the clear-to-environment gesture", async () => {
    await callerAs("admin").admin.updateSettings({ metricsToken: null, voiceUrl: null });
    const [values] = vi.mocked(db.saveInstanceSettings).mock.calls[0];
    expect(values).toEqual({ metricsToken: null, voiceUrl: null });
  });

  it("accepts a secret and does not echo it back", async () => {
    const result = await callerAs("admin").admin.updateSettings({
      voiceApiSecret: "NEW-SECRET",
      metricsToken: "NEW-TOKEN",
    });
    expect(result.hasVoiceApiSecret).toBe(true);
    expect(result.hasMetricsToken).toBe(true);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain("NEW-SECRET");
    expect(wire).not.toContain("NEW-TOKEN");
  });

  it("refuses a homeserver, issuer or IPFS address that is not http(s)", async () => {
    const admin = callerAs("admin");
    for (const bad of ["ftp://x", "not a url", "ws://x.example"]) {
      await expect(admin.admin.updateSettings({ matrixPublicUrl: bad })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(admin.admin.updateSettings({ identityIssuer: bad })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
      await expect(admin.admin.updateSettings({ ipfsApiUrl: bad })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(db.saveInstanceSettings).not.toHaveBeenCalled();
  });

  it("refuses a voice address that is not ws(s)", async () => {
    const admin = callerAs("admin");
    await expect(admin.admin.updateSettings({ voiceUrl: "https://voice.example" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await admin.admin.updateSettings({ voiceUrl: "wss://voice.example" });
    expect(db.saveInstanceSettings).toHaveBeenCalledTimes(1);
  });

  it("accepts an empty string for any URL field — that is how a field is cleared", async () => {
    await callerAs("admin").admin.updateSettings({
      matrixPublicUrl: "",
      voiceUrl: "",
      ipfsApiUrl: "",
    });
    const [values] = vi.mocked(db.saveInstanceSettings).mock.calls[0];
    expect(values).toEqual({ matrixPublicUrl: "", voiceUrl: "", ipfsApiUrl: "" });
  });

  it("bounds the ready timeout to something a load balancer survives", async () => {
    const admin = callerAs("admin");
    await expect(admin.admin.updateSettings({ readyTimeoutMs: 50 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(admin.admin.updateSettings({ readyTimeoutMs: 600_000 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(admin.admin.updateSettings({ readyTimeoutMs: 1.5 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await admin.admin.updateSettings({ readyTimeoutMs: 5000 });
    expect(db.saveInstanceSettings).toHaveBeenCalledTimes(1);
  });

  it("returns the resolved picture, including whether voice is now configured", async () => {
    // Stored key + secret, environment URL: configured by the same all-three
    // rule voice.ts applies. The response is what the form re-renders from,
    // so it has to say what the instance will actually do.
    const before = process.env.LIVEKIT_URL;
    process.env.LIVEKIT_URL = "wss://env.voice";
    try {
      const result = await callerAs("admin").admin.updateSettings({
        voiceApiKey: "k",
        voiceApiSecret: "s",
      });
      expect(result.voiceConfigured).toBe(true);
      expect(result.voiceUrl).toBe("wss://env.voice");
    } finally {
      if (before === undefined) delete process.env.LIVEKIT_URL;
      else process.env.LIVEKIT_URL = before;
    }
  });
});
