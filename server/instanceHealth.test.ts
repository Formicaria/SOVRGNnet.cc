import { describe, expect, it } from "vitest";
import {
  assessHealth,
  healthLabel,
  missingFeatures,
  shouldLoadInterface,
  type HealthProbe,
  type HealthProbes,
} from "@shared/instanceHealth";

function descriptor(overrides: Record<string, unknown> = {}) {
  return {
    product: "sovrgnnet",
    protocol: { major: 1, minor: 0 },
    server: { version: "0.4.0", id: "98efa4ac7047ab2a", name: "Test", description: null },
    capabilities: {
      messaging: true,
      media: true,
      e2ee: false,
      voice: false,
      federation: false,
      sso: false,
      publicRegistration: false,
      clientMatrix: false,
      portableBackup: true,
    },
    matrix: { serverName: "test.example", baseUrl: null },
    joinPolicy: "invite",
    identityIssuer: null,
    ...overrides,
  };
}

const ok = (body: unknown): HealthProbe => ({ ok: true, status: 200, body });
const failed = (error: string): HealthProbe => ({ ok: false, status: 0, body: null, error });

function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return {
    health: ok({ status: "ok", uptime: 3600 }),
    ready: ok({ ready: true, checks: { database: "ok", matrix: "ok" } }),
    instance: ok(descriptor()),
    ...overrides,
  };
}

describe("healthy", () => {
  it("reports everything running", () => {
    const health = assessHealth(probes());
    expect(health.state).toBe("healthy");
    expect(health.summary).toBe("Everything is running.");
  });

  it("offers no guidance when there is nothing to do", () => {
    expect(assessHealth(probes()).guidance).toEqual([]);
  });

  it("surfaces version and uptime", () => {
    const health = assessHealth(probes());
    expect(health.version).toBe("0.4.0");
    expect(health.uptimeSeconds).toBe(3600);
  });

  it("surfaces capabilities", () => {
    expect(assessHealth(probes()).capabilities?.messaging).toBe(true);
  });
});

describe("unreachable", () => {
  it("reports offline when nothing answers", () => {
    const health = assessHealth({
      health: failed("ECONNREFUSED"),
      instance: failed("ECONNREFUSED"),
    });
    expect(health.state).toBe("unreachable");
    expect(health.summary).toContain("Can't reach");
  });

  it("includes the underlying reason", () => {
    const health = assessHealth({
      health: failed("getaddrinfo ENOTFOUND nope.example"),
      instance: failed("getaddrinfo ENOTFOUND nope.example"),
    });
    expect(health.guidance.join(" ")).toContain("ENOTFOUND");
  });

  it("tells the operator what to run", () => {
    const health = assessHealth({ health: failed("timeout"), instance: failed("timeout") });
    expect(health.guidance.join(" ")).toContain("sovrgnnet status");
  });

  it("reassures that someone else's machine being off is normal", () => {
    const health = assessHealth({ health: failed("timeout"), instance: failed("timeout") });
    expect(health.guidance.join(" ")).toContain("stays in your list");
  });
});

describe("not a SOVRGNnet instance", () => {
  it("catches a different service at the address", () => {
    const health = assessHealth(probes({ instance: ok({ product: "nextcloud" }) }));
    expect(health.state).toBe("not-sovrgnnet");
    expect(health.summary).toContain("isn't SOVRGNnet");
  });

  it("catches a response that parses but is not a descriptor", () => {
    const health = assessHealth(probes({ instance: ok({ product: "sovrgnnet", nonsense: 1 }) }));
    expect(health.state).toBe("not-sovrgnnet");
  });

  it("suggests the address may be wrong", () => {
    const health = assessHealth(probes({ instance: ok({ product: "nextcloud" }) }));
    expect(health.guidance.join(" ")).toContain("address");
  });
});

describe("incompatible", () => {
  it("names the instance as too old, and whose job it is", () => {
    const health = assessHealth(
      probes({ instance: ok(descriptor({ protocol: { major: 0, minor: 9 } })) })
    );
    expect(health.state).toBe("incompatible");
    expect(health.summary).toContain("too old");
    // The operator has to fix it, not the person reading this.
    expect(health.guidance.join(" ")).toContain("operator");
  });

  it("tells the user to update when the instance is newer", () => {
    const health = assessHealth(
      probes({ instance: ok(descriptor({ protocol: { major: 2, minor: 0 } })) })
    );
    expect(health.state).toBe("incompatible");
    expect(health.guidance.join(" ")).toContain("Update this app");
  });

  it("still reports the version it saw", () => {
    const health = assessHealth(
      probes({ instance: ok(descriptor({ protocol: { major: 2, minor: 0 } })) })
    );
    expect(health.version).toBe("0.4.0");
  });
});

describe("degraded", () => {
  it("names the failing component rather than blaming the instance", () => {
    const health = assessHealth(
      probes({
        ready: { ok: false, status: 503, body: { ready: false, checks: { database: "down", matrix: "ok" } } },
      })
    );
    expect(health.state).toBe("degraded");
    // "The instance is down" sends someone restarting everything.
    expect(health.summary).toContain("database");
    expect(health.summary).toContain("app is running");
  });

  it("distinguishes a dead homeserver from a dead database", () => {
    const health = assessHealth(
      probes({
        ready: { ok: true, status: 200, body: { ready: true, checks: { database: "ok", matrix: "down" } } },
      })
    );
    expect(health.state).toBe("degraded");
    expect(health.guidance.join(" ")).toContain("Everything else still works");
  });

  it("says a dead database breaks everything", () => {
    const health = assessHealth(
      probes({
        ready: { ok: false, status: 503, body: { ready: false, checks: { database: "down" } } },
      })
    );
    expect(health.guidance.join(" ")).toContain("Nothing works without it");
  });

  it("lists two failures readably", () => {
    const health = assessHealth(
      probes({
        ready: {
          ok: true,
          status: 200,
          body: { ready: true, checks: { database: "ok", matrix: "down", ipfs: "down" } },
        },
      })
    );
    expect(health.summary).toContain("homeserver and file storage");
  });

  it("handles /health failing while discovery answers", () => {
    const health = assessHealth(probes({ health: failed("timeout") }));
    expect(health.state).toBe("degraded");
    expect(health.guidance.join(" ")).toContain("sovrgnnet logs");
  });

  it("marks the database fatal and the homeserver not", () => {
    const health = assessHealth(
      probes({
        ready: {
          ok: false,
          status: 503,
          body: { ready: false, checks: { database: "down", matrix: "down" } },
        },
      })
    );
    const db = health.dependencies.find(d => d.name === "Database");
    const matrix = health.dependencies.find(d => d.name === "Homeserver");
    expect(db?.fatal).toBe(true);
    expect(matrix?.fatal).toBe(false);
  });

  it("reports an unrecognised dependency without pretending to know it", () => {
    const health = assessHealth(
      probes({
        ready: { ok: true, status: 200, body: { ready: true, checks: { database: "ok", quantumflux: "down" } } },
      })
    );
    const unknown = health.dependencies.find(d => d.name === "quantumflux");
    expect(unknown?.ok).toBe(false);
    expect(unknown?.fatal).toBe(false);
  });

  it("copes with /ready absent entirely", () => {
    const health = assessHealth(probes({ ready: undefined }));
    expect(health.state).toBe("healthy");
    expect(health.dependencies).toEqual([]);
  });
});

describe("ordering", () => {
  it("reports 'not ours' before assessing dependencies", () => {
    // A degraded database on something that isn't a SOVRGNnet instance is not
    // a useful thing to say.
    const health = assessHealth({
      health: ok({ status: "ok" }),
      ready: { ok: false, status: 503, body: { ready: false, checks: { database: "down" } } },
      instance: ok({ product: "nextcloud" }),
    });
    expect(health.state).toBe("not-sovrgnnet");
  });

  it("reports incompatibility before dependencies", () => {
    const health = assessHealth({
      health: ok({ status: "ok" }),
      ready: { ok: false, status: 503, body: { ready: false, checks: { database: "down" } } },
      instance: ok(descriptor({ protocol: { major: 9, minor: 0 } })),
    });
    expect(health.state).toBe("incompatible");
  });
});

describe("shouldLoadInterface", () => {
  it("loads a healthy instance", () => {
    expect(shouldLoadInterface(assessHealth(probes()))).toBe(true);
  });

  it("still loads a degraded one — a UI that explains itself beats a blank window", () => {
    const health = assessHealth(
      probes({
        ready: { ok: false, status: 503, body: { ready: false, checks: { database: "down" } } },
      })
    );
    expect(shouldLoadInterface(health)).toBe(true);
  });

  it("does not load an unreachable one", () => {
    expect(
      shouldLoadInterface(assessHealth({ health: failed("x"), instance: failed("x") }))
    ).toBe(false);
  });

  it("does not load an incompatible one", () => {
    const health = assessHealth(
      probes({ instance: ok(descriptor({ protocol: { major: 5, minor: 0 } })) })
    );
    expect(shouldLoadInterface(health)).toBe(false);
  });
});

describe("missingFeatures", () => {
  it("reports what an instance cannot do", () => {
    const health = assessHealth(probes());
    expect(missingFeatures(health, ["voice", "e2ee", "messaging"])).toEqual(["voice", "e2ee"]);
  });

  it("treats everything as missing when there is no descriptor", () => {
    const health = assessHealth({ health: failed("x"), instance: failed("x") });
    expect(missingFeatures(health, ["voice", "messaging"])).toEqual(["voice", "messaging"]);
  });
});

describe("healthLabel", () => {
  it("labels every state", () => {
    for (const state of ["healthy", "degraded", "unreachable", "not-sovrgnnet", "incompatible"] as const) {
      expect(healthLabel(state).length).toBeGreaterThan(0);
    }
  });
});
