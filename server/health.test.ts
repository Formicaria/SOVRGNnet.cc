/**
 * Regression tests for the health and readiness endpoints.
 *
 * These exist because of a specific bug: `/ready` reported `database: "ok"`
 * against a DATABASE_URL that pointed nowhere. It called
 * `getInstanceSettings()`, which catches its own errors and returns null by
 * design — correct for serving traffic on defaults, useless as a probe.
 *
 * The bug was invisible to unit tests and to a casual look at the endpoint,
 * because the code reads as though it checks something. It was caught by
 * running the conformance suite against a live process with no database.
 */

import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pingDatabase = vi.fn();
const isHomeserverReachable = vi.fn();
const getInstanceSettings = vi.fn();

const getServerByInviteCode = vi.fn();

vi.mock("./db", () => ({
  pingDatabase: (...args: unknown[]) => pingDatabase(...args),
  getInstanceSettings: (...args: unknown[]) => getInstanceSettings(...args),
  getServerByInviteCode: (...args: unknown[]) => getServerByInviteCode(...args),
}));

vi.mock("./matrixService", () => ({
  isHomeserverReachable: (...args: unknown[]) => isHomeserverReachable(...args),
}));

let server: import("node:http").Server;
let base: string;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.MATRIX_SERVER_NAME = "test.example";
  // Short, so the hang tests below don't cost the suite the real bound.
  process.env.READY_TIMEOUT_MS = "300";

  // Sensible defaults so each test only states what it's actually about.
  pingDatabase.mockResolvedValue({ ok: true });
  isHomeserverReachable.mockResolvedValue(true);
  getInstanceSettings.mockResolvedValue(null);
  getServerByInviteCode.mockResolvedValue(null);

  const { registerInstanceRoutes } = await import("./instanceRoutes");
  const app = express();
  registerInstanceRoutes(app);

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("/health — liveness", () => {
  it("answers without consulting any dependency", async () => {
    pingDatabase.mockResolvedValue({ ok: false, error: "down" });
    isHomeserverReachable.mockResolvedValue(false);

    const response = await fetch(`${base}/health`);

    expect(response.status).toBe(200);
    // The point of the endpoint: the process is alive even though everything
    // it talks to is not.
    expect(pingDatabase).not.toHaveBeenCalled();
    expect(isHomeserverReachable).not.toHaveBeenCalled();
  });

  it("reports uptime", async () => {
    const body = await (await fetch(`${base}/health`)).json();
    expect(body.status).toBe("ok");
    expect(typeof body.uptime).toBe("number");
  });
});

describe("/ready — readiness", () => {
  it("reports 503 when the database is unreachable", async () => {
    pingDatabase.mockResolvedValue({ ok: false, error: "ECONNREFUSED" });
    isHomeserverReachable.mockResolvedValue(true);

    const response = await fetch(`${base}/ready`);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.ready).toBe(false);
    expect(body.checks.database).toBe("down");
  });

  it("includes why the database is down", async () => {
    pingDatabase.mockResolvedValue({ ok: false, error: "getaddrinfo ENOTFOUND db" });
    isHomeserverReachable.mockResolvedValue(true);

    const body = await (await fetch(`${base}/ready`)).json();
    expect(body.detail.database).toContain("ENOTFOUND");
  });

  it("uses pingDatabase, not a query that swallows its own errors", async () => {
    // The regression. getInstanceSettings returns null on failure rather than
    // throwing, so a readiness check built on it can never report a failure.
    await fetch(`${base}/ready`);

    expect(pingDatabase).toHaveBeenCalled();
    expect(getInstanceSettings).not.toHaveBeenCalled();
  });

  it("stays ready when only the homeserver is down", async () => {
    // A dead homeserver breaks messaging but not the instance. Reporting it as
    // not-ready would pull a partially working instance out of rotation.
    pingDatabase.mockResolvedValue({ ok: true });
    isHomeserverReachable.mockResolvedValue(false);

    const response = await fetch(`${base}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ready).toBe(true);
    expect(body.checks.matrix).toBe("down");
  });

  it("is 200 with everything healthy", async () => {
    pingDatabase.mockResolvedValue({ ok: true });
    isHomeserverReachable.mockResolvedValue(true);

    const response = await fetch(`${base}/ready`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ready: true, checks: { database: "ok", matrix: "ok" } });
  });

  it("answers even when the homeserver check never resolves", async () => {
    // The bug: isHomeserverReachable had no timeout, so while Dendrite was
    // starting the fetch hung and took /ready with it. A readiness probe that
    // never answers is worse than one reporting a failure — the caller gets a
    // timeout instead of information.
    pingDatabase.mockResolvedValue({ ok: true });
    isHomeserverReachable.mockReturnValue(new Promise(() => {}));

    const response = await Promise.race([
      fetch(`${base}/ready`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("/ready hung")), 5000)
      ),
    ]);

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.checks.matrix).toBe("down");
  });

  it("answers even when the database check never resolves", async () => {
    pingDatabase.mockReturnValue(new Promise(() => {}));
    isHomeserverReachable.mockResolvedValue(true);

    const response = await Promise.race([
      fetch(`${base}/ready`),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("/ready hung")), 5000)
      ),
    ]);

    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.checks.database).toBe("down");
    expect(body.detail.database).toBe("timed out");
  });

  it("never reports a dependency as 'unknown'", async () => {
    // "unknown" was the initial value of both checks, and an endpoint that can
    // return it is one that might not have looked.
    pingDatabase.mockResolvedValue({ ok: true });
    isHomeserverReachable.mockResolvedValue(false);

    const body = await (await fetch(`${base}/ready`)).json();
    expect(Object.values(body.checks)).not.toContain("unknown");
  });
});

describe("discovery endpoints are public", () => {
  it("serves /api/instance cross-origin without credentials", async () => {
    const response = await fetch(`${base}/api/instance`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves /api/capabilities", async () => {
    const body = await (await fetch(`${base}/api/capabilities`)).json();
    expect(body.capabilities).toBeDefined();
    expect(body.protocol).toBeDefined();
  });

  it("never claims E2EE", async () => {
    const body = await (await fetch(`${base}/api/capabilities`)).json();
    expect(body.capabilities.e2ee).toBe(false);
  });
});
