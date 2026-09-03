/**
 * Regression tests for the desktop shell's first-account preflight.
 *
 * v0.7.2 on Windows: the shell's webview (origin http://tauri.localhost)
 * POSTs JSON to /api/trpc/auth.register. A JSON POST is non-simple, so
 * WebView2 asks OPTIONS first; nothing answered it, the real request was
 * never sent, and account creation died on the panel as "Failed to fetch" —
 * directly under the sentence saying the server is running. The instance
 * probe worked all along, which is exactly why the form was on screen.
 *
 * The allowance lives in registerInstanceRoutes, which _core/index.ts
 * registers ahead of the tRPC mount; the stub POST route below stands in
 * for that mount.
 */

import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({
  pingDatabase: () => Promise.resolve({ ok: true }),
  getInstanceSettings: () => Promise.resolve(null),
  getServerByInviteCode: () => Promise.resolve(null),
  countUsers: () => Promise.resolve(1),
}));

vi.mock("./matrixService", () => ({
  isHomeserverReachable: () => Promise.resolve(true),
}));

let server: import("node:http").Server;
let base: string;
const registered = vi.fn();

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.MATRIX_SERVER_NAME = "test.example";

  const { registerInstanceRoutes } = await import("./instanceRoutes");
  const app = express();
  registerInstanceRoutes(app);
  // Stands in for the tRPC mount, registered after — as in _core/index.ts.
  app.post("/api/trpc/auth.register", (_req, res) => {
    registered();
    res.json({ result: { data: { json: { ok: true } } } });
  });

  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

describe("/api/trpc/auth.register — the desktop shell's cross-origin bootstrap", () => {
  it("answers the preflight the Windows webview sends", async () => {
    const res = await fetch(`${base}/api/trpc/auth.register`, {
      method: "OPTIONS",
      headers: {
        origin: "http://tauri.localhost",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(
      (res.headers.get("access-control-allow-headers") ?? "").toLowerCase()
    ).toContain("content-type");
    // The preflight is an answer, not a registration.
    expect(registered).not.toHaveBeenCalled();
  });

  it("stamps the POST response, then stays out of the way", async () => {
    // Without the stamp on the response itself, the account is created and
    // the webview still reports failure — worse than the bug this replaces.
    const res = await fetch(`${base}/api/trpc/auth.register`, {
      method: "POST",
      headers: {
        origin: "http://tauri.localhost",
        "content-type": "application/json",
      },
      body: JSON.stringify({ json: { username: "a", password: "b" } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(registered).toHaveBeenCalledTimes(1);
  });

  it("does not blanket the rest of the tRPC surface", async () => {
    const res = await fetch(`${base}/api/trpc/auth.me`, { method: "OPTIONS" });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
