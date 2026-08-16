import { describe, expect, it } from "vitest";
import { runConformance, summarize, type Probe, type Probes } from "@shared/conformance";

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

function okProbe(body: unknown): Probe {
  return {
    ok: true,
    status: 200,
    body,
    headers: { "access-control-allow-origin": "*" },
  };
}

function probes(overrides: Partial<Probes> = {}): Probes {
  const d = descriptor();
  return {
    instance: okProbe(d),
    capabilities: okProbe({ protocol: d.protocol, capabilities: d.capabilities }),
    version: okProbe({ server: "0.4.0", protocol: d.protocol }),
    health: okProbe({ status: "ok" }),
    ready: okProbe({ ready: true, database: "ok" }),
    ...overrides,
  };
}

function find(results: ReturnType<typeof runConformance>, id: string) {
  return results.find(r => r.id === id);
}

describe("a healthy instance", () => {
  it("conforms", () => {
    const results = runConformance(probes());
    const summary = summarize(results);
    expect(summary.conformant).toBe(true);
    expect(summary.failed).toBe(0);
  });

  it("reports no warnings when everything is served", () => {
    expect(summarize(runConformance(probes())).warned).toBe(0);
  });
});

describe("reachability", () => {
  it("stops immediately when the instance can't be reached", () => {
    const results = runConformance(
      probes({ instance: { ok: false, status: 0, body: null, error: "ECONNREFUSED" } })
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("ECONNREFUSED");
  });

  it("fails when discovery requires authentication", () => {
    const results = runConformance(
      probes({ instance: { ok: false, status: 401, body: null, headers: {} } })
    );
    expect(find(results, "reachable")?.status).toBe("fail");
    expect(find(results, "reachable")?.detail).toContain("unauthenticated");
  });

  it("fails when the body isn't JSON", () => {
    const results = runConformance(probes({ instance: okProbe("<html>hello</html>") }));
    expect(find(results, "json")?.status).toBe("fail");
  });
});

describe("identity", () => {
  it("fails when the service isn't SOVRGNnet", () => {
    const results = runConformance(
      probes({ instance: okProbe({ ...descriptor(), product: "something-else" }) })
    );
    expect(find(results, "product")?.status).toBe("fail");
  });

  it("fails a descriptor that doesn't match the schema", () => {
    const results = runConformance(
      probes({ instance: okProbe({ product: "sovrgnnet", protocol: "one point oh" }) })
    );
    expect(find(results, "descriptor")?.status).toBe("fail");
  });
});

describe("descriptor diagnostics", () => {
  // A second implementation gets one shot at understanding why it was
  // rejected. "Schema mismatch" wastes it.
  function reasonFor(body: unknown): string {
    return find(runConformance(probes({ instance: okProbe(body) })), "descriptor")?.detail ?? "";
  }

  it("names the id format, and why it is normative", () => {
    const d = descriptor();
    d.server.id = "my-cool-server";
    const reason = reasonFor(d);
    expect(reason).toContain("16 lowercase hex");
    expect(reason).toContain("audience");
  });

  it("catches an id of the wrong length", () => {
    const d = descriptor();
    d.server.id = "abc123";
    expect(reasonFor(d)).toContain("16 lowercase hex");
  });

  it("catches uppercase hex", () => {
    const d = descriptor();
    d.server.id = "98EFA4AC7047AB2A";
    expect(reasonFor(d)).toContain("16 lowercase hex");
  });

  it("names a missing server object", () => {
    expect(reasonFor({ product: "sovrgnnet", protocol: { major: 1, minor: 0 } })).toContain(
      "No `server` object"
    );
  });

  it("names a missing id before anything else", () => {
    const d = descriptor() as Record<string, unknown>;
    delete (d.server as Record<string, unknown>).id;
    expect(reasonFor(d)).toContain("`server.id` is missing");
  });

  it("names an empty server name", () => {
    const d = descriptor();
    d.server.name = "";
    expect(reasonFor(d)).toContain("`server.name`");
  });

  it("names a malformed protocol version", () => {
    const d = descriptor({ protocol: { major: "one", minor: 0 } });
    expect(reasonFor(d)).toContain("`protocol`");
  });

  it("names a missing matrix server name", () => {
    const d = descriptor({ matrix: { baseUrl: null } });
    expect(reasonFor(d)).toContain("`matrix.serverName`");
  });

  it("names an unrecognised join policy", () => {
    const d = descriptor({ joinPolicy: "sometimes" });
    expect(reasonFor(d)).toContain("open, invite, or closed");
  });

  it("always points at the specification", () => {
    const d = descriptor();
    d.server.id = "nope";
    expect(reasonFor(d)).toContain("docs/PROTOCOL.md");
  });
});

describe("protocol version", () => {
  it("accepts a newer minor version", () => {
    const results = runConformance(
      probes({ instance: okProbe(descriptor({ protocol: { major: 1, minor: 9 } })) })
    );
    expect(find(results, "protocol")?.status).toBe("pass");
  });

  it("fails a different major version", () => {
    const results = runConformance(
      probes({ instance: okProbe(descriptor({ protocol: { major: 2, minor: 0 } })) })
    );
    expect(find(results, "protocol")?.status).toBe("fail");
  });
});

describe("endpoints", () => {
  it("fails when CORS is missing — a browser client cannot connect", () => {
    const results = runConformance(
      probes({ instance: { ok: true, status: 200, body: descriptor(), headers: {} } })
    );
    expect(find(results, "cors")?.status).toBe("fail");
  });

  it("fails when /health depends on the database", () => {
    const results = runConformance(
      probes({ health: { ok: false, status: 503, body: null, headers: {} } })
    );
    const health = find(results, "health-endpoint");
    expect(health?.status).toBe("fail");
    expect(health?.detail).toContain("/ready");
  });

  it("only warns when /ready reports the instance as degraded", () => {
    const results = runConformance(
      probes({ ready: { ok: false, status: 503, body: { ready: false }, headers: {} } })
    );
    expect(find(results, "ready-endpoint")?.status).toBe("warn");
  });

  it("warns rather than fails when optional endpoints are absent", () => {
    const results = runConformance(
      probes({ capabilities: undefined, version: undefined, health: undefined, ready: undefined })
    );
    expect(summarize(results).conformant).toBe(true);
    expect(summarize(results).warned).toBeGreaterThanOrEqual(4);
  });

  it("fails when the two capability sources disagree", () => {
    const d = descriptor();
    const results = runConformance(
      probes({
        instance: okProbe(d),
        capabilities: okProbe({
          protocol: d.protocol,
          capabilities: { ...d.capabilities, voice: true },
        }),
      })
    );
    const check = find(results, "capabilities-endpoint");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("voice");
  });
});

describe("self-consistency", () => {
  it("catches publicRegistration on a closed instance", () => {
    const d = descriptor();
    d.capabilities.publicRegistration = true;
    d.joinPolicy = "closed";
    const results = runConformance(probes({ instance: okProbe(d) }));
    expect(find(results, "consistency-registration")?.status).toBe("fail");
  });

  it("catches an E2EE claim the architecture cannot support", () => {
    const d = descriptor();
    d.capabilities.e2ee = true;
    d.capabilities.clientMatrix = false;
    const results = runConformance(probes({ instance: okProbe(d) }));
    const check = find(results, "consistency-e2ee");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("holds the keys");
  });

  it("accepts E2EE alongside client-side Matrix", () => {
    const d = descriptor();
    d.capabilities.e2ee = true;
    d.capabilities.clientMatrix = true;
    d.matrix.baseUrl = "https://matrix.test.example";
    const results = runConformance(probes({ instance: okProbe(d) }));
    expect(find(results, "consistency-e2ee")?.status).toBe("pass");
  });

  it("catches clientMatrix with nowhere to connect", () => {
    const d = descriptor();
    d.capabilities.clientMatrix = true;
    const results = runConformance(probes({ instance: okProbe(d) }));
    expect(find(results, "consistency-matrix-url")?.status).toBe("fail");
  });

  it("catches SSO with no issuer", () => {
    const d = descriptor();
    d.capabilities.sso = true;
    const results = runConformance(probes({ instance: okProbe(d) }));
    expect(find(results, "consistency-sso")?.status).toBe("fail");
  });

  it("warns about a communications server that can't communicate", () => {
    const d = descriptor();
    d.capabilities.messaging = false;
    const results = runConformance(probes({ instance: okProbe(d) }));
    expect(find(results, "consistency-messaging")?.status).toBe("warn");
  });
});

describe("disclosure", () => {
  it("fails when the public descriptor lists members", () => {
    const results = runConformance(
      probes({ instance: okProbe({ ...descriptor(), members: [{ id: 1, name: "zach" }] }) })
    );
    const check = find(results, "no-leakage");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("members");
  });

  it("fails when it lists channels", () => {
    const results = runConformance(
      probes({ instance: okProbe({ ...descriptor(), channels: ["general"] }) })
    );
    expect(find(results, "no-leakage")?.status).toBe("fail");
  });

  it("passes a clean descriptor", () => {
    expect(find(runConformance(probes()), "no-leakage")?.status).toBe("pass");
  });

  it("does not mistake a Matrix server name for an email address", () => {
    const results = runConformance(
      probes({ instance: okProbe(descriptor({ matrix: { serverName: "test.example", baseUrl: null } })) })
    );
    expect(find(results, "no-leakage")?.status).toBe("pass");
  });
});

describe("summarize", () => {
  it("treats warnings as advice, not violations", () => {
    const results = runConformance(probes({ version: undefined }));
    const summary = summarize(results);
    expect(summary.warned).toBeGreaterThan(0);
    expect(summary.conformant).toBe(true);
  });

  it("is not conformant with any failure", () => {
    const results = runConformance(
      probes({ instance: { ok: true, status: 200, body: descriptor(), headers: {} } })
    );
    expect(summarize(results).conformant).toBe(false);
  });
});
