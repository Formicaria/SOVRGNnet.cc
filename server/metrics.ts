import type { Express, Request } from "express";
import { APP_VERSION } from "@shared/const";
import * as db from "./db";
import { isIpfsReachable } from "./ipfsService";
import * as matrix from "./matrixService";

/**
 * Prometheus-compatible metrics — the 0.5 "portable infrastructure" box that
 * says an instance can be watched by the tools operators already run.
 *
 * Hand-written text exposition rather than a client library: the format is
 * `name{labels} value` per line, and this instance exports a dozen series.
 * A dependency that ships histograms, summaries, and a default registry to
 * produce twelve lines would be the heaviest thing in the server for the
 * least reason.
 *
 * Design rules:
 * - **Gauges are probed at scrape time, bounded at 2s each.** A metrics
 *   endpoint that hangs when a dependency hangs takes the monitoring down
 *   with the incident — the exact moment it was for.
 * - **No per-user or per-community series.** Cardinality is a cost paid by
 *   the operator's Prometheus forever, and member counts as *labels* would
 *   leak what the descriptor deliberately doesn't say. Totals only.
 * - **Optional bearer auth.** METRICS_TOKEN set → required. Unset, the
 *   endpoint answers — stock deployments only expose it on the internal
 *   network, and totals are what the operator can already see.
 */

const startedAt = Date.now();

// Counters survive for the process lifetime; Prometheus handles resets.
const counters = new Map<string, number>();

/** Increment a named counter — the app's only write surface into metrics. */
export function countMetric(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function __resetMetricsForTests(): void {
  counters.clear();
}

function bounded<T>(work: Promise<T>, fallback: T, ms = 2000): Promise<T> {
  return Promise.race([
    work.catch(() => fallback),
    new Promise<T>(resolve => setTimeout(() => resolve(fallback), ms)),
  ]);
}

interface Line {
  name: string;
  help: string;
  type: "gauge" | "counter";
  value: number;
  labels?: Record<string, string>;
}

function render(lines: Line[]): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (!seen.has(line.name)) {
      out.push(`# HELP ${line.name} ${line.help}`);
      out.push(`# TYPE ${line.name} ${line.type}`);
      seen.add(line.name);
    }
    const labels = line.labels
      ? `{${Object.entries(line.labels)
          .map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`)
          .join(",")}}`
      : "";
    out.push(`${line.name}${labels} ${line.value}`);
  }
  return out.join("\n") + "\n";
}

export function registerMetricsRoutes(app: Express): void {
  app.get("/metrics", async (req: Request, res) => {
    const required = process.env.METRICS_TOKEN;
    if (required) {
      const header = req.headers.authorization;
      const presented = header?.startsWith("Bearer ") ? header.slice(7) : null;
      if (presented !== required) {
        return res.status(403).type("text/plain").send("forbidden\n");
      }
    }

    const [databaseUp, homeserverUp, ipfsUp, totals] = await Promise.all([
      bounded(
        db.pingDatabase().then(r => (r.ok ? 1 : 0)),
        0
      ),
      bounded(matrix.isHomeserverReachable().then(v => (v ? 1 : 0)), 0),
      bounded(isIpfsReachable().then(v => (v ? 1 : 0)), 0),
      bounded(db.countTotals(), null),
    ]);

    const memory = process.memoryUsage();

    const lines: Line[] = [
      {
        name: "sovrgnnet_info",
        help: "Build information. Value is always 1; the version is a label.",
        type: "gauge",
        value: 1,
        labels: { version: APP_VERSION },
      },
      {
        name: "sovrgnnet_uptime_seconds",
        help: "Seconds since this process started.",
        type: "gauge",
        value: Math.floor((Date.now() - startedAt) / 1000),
      },
      {
        name: "sovrgnnet_resident_memory_bytes",
        help: "Resident set size of the instance process.",
        type: "gauge",
        value: memory.rss,
      },
      {
        name: "sovrgnnet_database_up",
        help: "1 when the database answers a ping, 0 otherwise.",
        type: "gauge",
        value: databaseUp,
      },
      {
        name: "sovrgnnet_homeserver_up",
        help: "1 when the Matrix homeserver answers /versions, 0 otherwise.",
        type: "gauge",
        value: homeserverUp,
      },
      {
        name: "sovrgnnet_ipfs_up",
        help: "1 when the IPFS daemon answers, 0 otherwise.",
        type: "gauge",
        value: ipfsUp,
      },
    ];

    if (totals) {
      lines.push(
        {
          name: "sovrgnnet_users_total",
          help: "Accounts on this instance.",
          type: "gauge",
          value: totals.users,
        },
        {
          name: "sovrgnnet_communities_total",
          help: "Communities on this instance.",
          type: "gauge",
          value: totals.servers,
        },
        {
          name: "sovrgnnet_messages_total",
          help: "Messages in the index.",
          type: "gauge",
          value: totals.messages,
        }
      );
    }

    for (const [name, value] of Array.from(counters.entries())) {
      lines.push({
        name,
        help: "Application counter.",
        type: "counter",
        value,
      });
    }

    res
      .type("text/plain; version=0.0.4; charset=utf-8")
      .send(render(lines));
  });
}
