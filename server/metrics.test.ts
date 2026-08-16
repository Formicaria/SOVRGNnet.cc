import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pingDatabase = vi.fn();
const countTotals = vi.fn();
const isHomeserverReachable = vi.fn();
const isIpfsReachable = vi.fn();

vi.mock("./db", () => ({
  pingDatabase: (...args: unknown[]) => pingDatabase(...args),
  countTotals: (...args: unknown[]) => countTotals(...args),
}));
vi.mock("./matrixService", () => ({
  isHomeserverReachable: (...args: unknown[]) => isHomeserverReachable(...args),
}));
vi.mock("./ipfsService", () => ({
  isIpfsReachable: (...args: unknown[]) => isIpfsReachable(...args),
}));

let server: import("node:http").Server;
let base: string;

async function start() {
  const { registerMetricsRoutes } = await import("./metrics");
  const app = express();
  registerMetricsRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(async () => {
  vi.clearAllMocks();
  delete process.env.METRICS_TOKEN;
  pingDatabase.mockResolvedValue({ ok: true });
  countTotals.mockResolvedValue({ users: 3, servers: 2, messages: 41 });
  isHomeserverReachable.mockResolvedValue(true);
  isIpfsReachable.mockResolvedValue(true);
  await start();
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.METRICS_TOKEN;
});

describe("/metrics", () => {
  it("speaks Prometheus text exposition", async () => {
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");

    const body = await response.text();
    expect(body).toContain("# TYPE sovrgnnet_database_up gauge");
    expect(body).toContain("sovrgnnet_database_up 1");
    expect(body).toContain("sovrgnnet_homeserver_up 1");
    expect(body).toContain("sovrgnnet_ipfs_up 1");
    expect(body).toContain("sovrgnnet_users_total 3");
    expect(body).toContain("sovrgnnet_messages_total 41");
    expect(body).toMatch(/sovrgnnet_info\{version="[^"]+"\} 1/);
  });

  it("reports dependencies down as 0, not as an error", async () => {
    pingDatabase.mockResolvedValue({ ok: false, error: "down" });
    isHomeserverReachable.mockRejectedValue(new Error("refused"));

    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("sovrgnnet_database_up 0");
    expect(body).toContain("sovrgnnet_homeserver_up 0");
  });

  it("answers even when a dependency hangs — monitoring must not die with the incident", async () => {
    isHomeserverReachable.mockImplementation(
      () => new Promise(() => {})
    );

    const started = Date.now();
    const response = await fetch(`${base}/metrics`);
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await response.text()).toContain("sovrgnnet_homeserver_up 0");
  });

  it("omits totals when the database can't answer, rather than reporting zeros as truth", async () => {
    countTotals.mockRejectedValue(new Error("no db"));
    const body = await (await fetch(`${base}/metrics`)).text();
    expect(body).not.toContain("sovrgnnet_users_total");
    // The up gauge still tells the operator why.
    expect(body).toContain("sovrgnnet_database_up");
  });

  it("requires the bearer token when METRICS_TOKEN is set", async () => {
    process.env.METRICS_TOKEN = "scrape-secret";

    expect((await fetch(`${base}/metrics`)).status).toBe(403);
    expect(
      (
        await fetch(`${base}/metrics`, {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status
    ).toBe(403);

    const ok = await fetch(`${base}/metrics`, {
      headers: { Authorization: "Bearer scrape-secret" },
    });
    expect(ok.status).toBe(200);
  });
});
