import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  capabilitiesSchema,
  checkCompatibility,
  explainMissing,
  instanceDescriptorSchema,
  parseInstanceDescriptor,
  supports,
  type InstanceDescriptor,
} from "@shared/protocol";

function descriptor(over: Record<string, unknown> = {}): unknown {
  return {
    product: "sovrgnnet",
    protocol: { major: 1, minor: 0 },
    server: {
      version: "0.4.0",
      id: "abc123def4567890",
      name: "Zach's instance",
      description: null,
    },
    capabilities: { messaging: true, media: true },
    matrix: { serverName: "sovrgnnet.cc", baseUrl: null },
    joinPolicy: "invite",
    identityIssuer: null,
    ...over,
  };
}

describe("capabilities", () => {
  it("default to absent, not present", () => {
    // The direction matters: an instance that has never heard of a capability
    // must read as "doesn't have it", never as "probably fine".
    const caps = capabilitiesSchema.parse({});
    expect(caps.e2ee).toBe(false);
    expect(caps.voice).toBe(false);
    expect(caps.federation).toBe(false);
    expect(caps.sso).toBe(false);
    expect(caps.publicRegistration).toBe(false);
    expect(caps.clientMatrix).toBe(false);
    expect(caps.portableBackup).toBe(false);
  });

  it("assumes messaging, since every instance has it", () => {
    expect(capabilitiesSchema.parse({}).messaging).toBe(true);
  });

  it("reads what an instance actually declares", () => {
    const caps = capabilitiesSchema.parse({ e2ee: true, voice: true });
    expect(caps.e2ee).toBe(true);
    expect(caps.voice).toBe(true);
  });
});

describe("supports", () => {
  const parsed = instanceDescriptorSchema.parse(descriptor());

  it("is true for a declared capability", () => {
    expect(supports(parsed, "media")).toBe(true);
  });

  it("is false for one the instance never mentioned", () => {
    expect(supports(parsed, "voice")).toBe(false);
  });

  it("is false rather than throwing when capabilities are missing entirely", () => {
    // A descriptor from something older or broken must degrade, not crash.
    expect(supports({ capabilities: undefined } as never, "e2ee")).toBe(false);
  });
});

describe("checkCompatibility", () => {
  it("accepts a matching major version", () => {
    expect(checkCompatibility({ major: 1, minor: 0 })).toEqual({
      ok: true,
      protocol: { major: 1, minor: 0 },
    });
  });

  it("accepts a newer minor on the instance", () => {
    // Minor additions are backward compatible — the older client simply
    // doesn't ask for them.
    expect(checkCompatibility({ major: 1, minor: 7 }).ok).toBe(true);
  });

  it("accepts an older minor on the instance", () => {
    // The important case for sovereignty: someone's server has been quietly
    // running for a year and must still work.
    expect(checkCompatibility({ major: 1, minor: 0 }, { major: 1, minor: 9 }).ok).toBe(true);
  });

  it("refuses when the instance is a newer major", () => {
    const result = checkCompatibility({ major: 2, minor: 0 }, { major: 1, minor: 0 });
    expect(result).toMatchObject({ ok: false, reason: "client-too-old" });
  });

  it("refuses when the instance is an older major", () => {
    const result = checkCompatibility({ major: 1, minor: 0 }, { major: 2, minor: 0 });
    expect(result).toMatchObject({ ok: false, reason: "server-too-old" });
  });

  it("says which side needs updating", () => {
    const old = checkCompatibility({ major: 2, minor: 0 }, { major: 1, minor: 0 });
    if (old.ok) throw new Error("expected incompatible");
    expect(old.message).toMatch(/update your client/i);

    const ancient = checkCompatibility({ major: 1, minor: 0 }, { major: 2, minor: 0 });
    if (ancient.ok) throw new Error("expected incompatible");
    expect(ancient.message).toMatch(/operator/i);
  });
});

describe("parseInstanceDescriptor", () => {
  it("parses a well-formed descriptor", () => {
    const parsed = parseInstanceDescriptor(descriptor());
    expect(parsed).not.toBeNull();
    expect(parsed?.server.name).toBe("Zach's instance");
  });

  it("fills defaults for anything omitted", () => {
    const parsed = parseInstanceDescriptor(descriptor({ capabilities: {} }));
    expect(parsed?.capabilities.e2ee).toBe(false);
    expect(parsed?.joinPolicy).toBe("invite");
  });

  describe("refuses rather than throwing", () => {
    it("on something that isn't SOVRGNnet", () => {
      expect(parseInstanceDescriptor({ hello: "world" })).toBeNull();
      expect(parseInstanceDescriptor(descriptor({ product: "matrix" }))).toBeNull();
    });

    it("on a malformed instance id", () => {
      // The id ends up in URLs and as a token audience; a loose one is a
      // problem later rather than here.
      expect(
        parseInstanceDescriptor(descriptor({ server: { version: "1", id: "../etc", name: "x" } }))
      ).toBeNull();
    });

    it("on a missing protocol version", () => {
      expect(parseInstanceDescriptor(descriptor({ protocol: undefined }))).toBeNull();
    });

    it("on structurally broken input", () => {
      for (const bad of [null, undefined, 42, "text", []]) {
        expect(parseInstanceDescriptor(bad)).toBeNull();
      }
    });
  });
});

describe("explainMissing", () => {
  it("explains every capability in words a person can act on", () => {
    const names = Object.keys(capabilitiesSchema.parse({})) as Array<
      keyof InstanceDescriptor["capabilities"]
    >;
    for (const name of names) {
      const reason = explainMissing(name);
      expect(reason.length).toBeGreaterThan(15);
      // Graceful degradation means explaining, not showing a field name.
      expect(reason).not.toBe(name);
    }
  });

  it("is honest about what missing encryption means", () => {
    expect(explainMissing("e2ee")).toMatch(/readable by whoever runs it/i);
  });
});

describe("the protocol version this build speaks", () => {
  it("is a real version", () => {
    expect(PROTOCOL_VERSION.major).toBeGreaterThanOrEqual(1);
    expect(checkCompatibility(PROTOCOL_VERSION).ok).toBe(true);
  });
});
