import { describe, expect, it } from "vitest";
import {
  COMPONENTS,
  INSTALL_STEPS,
  PORT_SEARCH_RANGE,
  PREFERRED_PORTS,
  evaluate,
  installProgress,
  isUsable,
  needsBackupBeforeUpgrade,
  portCandidates,
  type Component,
  type ComponentId,
  type ComponentState,
} from "@shared/hosting";

const URL = "http://localhost:3100";

function make(states: Partial<Record<ComponentId, ComponentState>>): Component[] {
  return COMPONENTS.map(id => ({
    id,
    state: states[id] ?? "running",
    port: PREFERRED_PORTS[id],
    error: null,
  }));
}

describe("ports", () => {
  it("avoids the defaults a developer's own services already use", () => {
    // 5432, 5001, and 3000 are all likely taken on a machine someone works on.
    expect(PREFERRED_PORTS.postgres).not.toBe(5432);
    expect(PREFERRED_PORTS.ipfs).not.toBe(5001);
    expect(PREFERRED_PORTS.app).not.toBe(3000);
  });

  it("offers a range to fall back through", () => {
    const candidates = portCandidates("app");
    expect(candidates).toHaveLength(PORT_SEARCH_RANGE);
    expect(candidates[0]).toBe(PREFERRED_PORTS.app);
    expect(candidates[1]).toBe(PREFERRED_PORTS.app + 1);
  });

  it("gives every component a distinct starting point", () => {
    const ports = Object.values(PREFERRED_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe("isUsable", () => {
  it("is true once the app answers", () => {
    expect(isUsable(make({}))).toBe(true);
  });

  it("is false while the app is still coming up", () => {
    expect(isUsable(make({ app: "starting" }))).toBe(false);
  });

  it("is true even when file storage is down", () => {
    // Files fail; chat works. Refusing to open a working chat would be wrong.
    expect(isUsable(make({ ipfs: "failed" }))).toBe(true);
  });
});

describe("evaluate", () => {
  it("reports running when everything is healthy", () => {
    expect(evaluate(make({}), URL)).toEqual({
      status: "running",
      components: make({}),
      url: URL,
    });
  });

  it("reports stopped when nothing is up", () => {
    const all = make({ postgres: "stopped", conduit: "stopped", ipfs: "stopped", app: "stopped" });
    expect(evaluate(all, URL).status).toBe("stopped");
  });

  it("reports starting while components are coming up", () => {
    expect(evaluate(make({ app: "starting", conduit: "starting" }), URL).status).toBe(
      "starting"
    );
  });

  describe("degraded rather than broken", () => {
    it("stays usable when only file storage is down", () => {
      const state = evaluate(make({ ipfs: "failed" }), URL);

      expect(state.status).toBe("degraded");
      if (state.status !== "degraded") throw new Error("expected degraded");
      expect(state.url).toBe(URL);
      expect(state.problem).toMatch(/file sharing/i);
    });

    it("says so in words a person can act on", () => {
      const state = evaluate(make({ ipfs: "unhealthy" }), URL);
      if (state.status !== "degraded") throw new Error("expected degraded");
      // Not "ipfs: unhealthy" — that tells a non-technical person nothing.
      expect(state.problem).not.toMatch(/ipfs/i);
      expect(state.problem).toMatch(/works/i);
    });
  });

  describe("actually broken", () => {
    it("fails when the database is down", () => {
      const state = evaluate(make({ postgres: "failed", app: "failed" }), URL);
      expect(state.status).toBe("failed");
    });

    it("fails when the chat server is down", () => {
      expect(evaluate(make({ conduit: "failed", app: "failed" }), URL).status).toBe("failed");
    });

    it("explains the failure in human terms, with the underlying error", () => {
      const components = make({ postgres: "failed", app: "failed" });
      components[0].error = "port already in use";

      const state = evaluate(components, URL);
      if (state.status !== "failed") throw new Error("expected failed");
      expect(state.problem).toContain("the database");
      expect(state.problem).toContain("port already in use");
    });

    it("still explains itself with no error attached", () => {
      const state = evaluate(make({ conduit: "failed", app: "failed" }), URL);
      if (state.status !== "failed") throw new Error("expected failed");
      expect(state.problem.length).toBeGreaterThan(10);
    });
  });

  it("treats a failed database as fatal even if the app hasn't noticed yet", () => {
    // The app can briefly look fine after its database dies. Reporting
    // "running" in that window sends someone into a server about to break.
    expect(evaluate(make({ postgres: "failed" }), URL).status).toBe("failed");
  });
});

describe("install progress", () => {
  it("gives every step a person-readable label", () => {
    for (const step of INSTALL_STEPS) {
      expect(step.label.length).toBeGreaterThan(4);
      expect(step.label).not.toMatch(/postgres|conduit|kubo|ipfs/i);
    }
  });

  it("advances through the steps", () => {
    expect(installProgress("unpack")).toEqual({ completed: 1, total: INSTALL_STEPS.length });
    expect(installProgress("start")).toEqual({
      completed: INSTALL_STEPS.length,
      total: INSTALL_STEPS.length,
    });
  });

  it("doesn't crash on a step it doesn't know", () => {
    expect(installProgress("nonsense")).toEqual({ completed: 0, total: INSTALL_STEPS.length });
  });
});

describe("needsBackupBeforeUpgrade", () => {
  it("requires a backup across a major version change", () => {
    expect(needsBackupBeforeUpgrade("16.2", "17.0")).toBe(true);
  });

  it("doesn't for a minor update", () => {
    expect(needsBackupBeforeUpgrade("16.2", "16.4")).toBe(false);
    expect(needsBackupBeforeUpgrade("16.2", "16.2")).toBe(false);
  });

  it("requires one when going backwards, which shouldn't happen", () => {
    expect(needsBackupBeforeUpgrade("17.0", "16.4")).toBe(true);
  });

  it("requires one when either version is unreadable", () => {
    // Not knowing what's on disk is the most alarming case, not the least —
    // this is the branch standing between a bad upgrade and someone's
    // entire message history.
    expect(needsBackupBeforeUpgrade("", "17.0")).toBe(true);
    expect(needsBackupBeforeUpgrade("unknown", "17.0")).toBe(true);
    expect(needsBackupBeforeUpgrade("16.2", "")).toBe(true);
  });
});
