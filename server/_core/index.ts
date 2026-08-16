import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
// First-party auth: session cookie resolved in createContext
import { appRouter } from "../routers";
import { registerAppserviceRoutes } from "../appservice";
import { registerFileRoutes } from "../fileRoutes";
import { registerInstanceRoutes } from "../instanceRoutes";
import { refreshDirectSync } from "../matrixPublic";
import { registerMetricsRoutes } from "../metrics";
import { runMigrations, waitForDatabase } from "../migrate";
import { createContext } from "./context";
import { serveStatic } from "./static";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // Bring the schema up to date before serving traffic. Self-hosters should
  // never have to run a migration command by hand.
  if (process.env.DATABASE_URL) {
    const reachable = await waitForDatabase();
    if (reachable) {
      try {
        await runMigrations();
      } catch (error) {
        console.error("[Migrate] Migration failed:", error);
        if (process.env.NODE_ENV === "production") process.exit(1);
      }
    } else if (process.env.NODE_ENV === "production") {
      console.error("Cannot reach the database. Exiting.");
      process.exit(1);
    }
  }

  const app = express();
  const server = createServer(app);

  // Warm the direct-sync probe before traffic arrives, and keep it warmer
  // than its own staleness bound. Without this, the first request after boot
  // sees "unverified" while triggering the probe, and the *next* request sees
  // the answer — so two endpoints asked in sequence disagree about
  // clientMatrix. The conformance suite caught exactly that: /api/instance
  // and /api/capabilities split on a capability during the first seconds of
  // life. refreshDirectSync's comment always said "used at startup"; now it
  // is. The interval is unref'd so it never holds the process open.
  void refreshDirectSync().catch(() => {});
  setInterval(() => {
    void refreshDirectSync().catch(() => {});
  }, 45_000).unref();

  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Public identity: how a client that has never seen this server finds out
  // what it is. Registered before auth-bearing routes because none of it
  // requires a session.
  registerInstanceRoutes(app);
  // Homeserver event pushes (ADR 0009) — hs_token-gated, 404 when unconfigured
  registerAppserviceRoutes(app);
  // Prometheus text exposition; METRICS_TOKEN makes it bearer-gated
  registerMetricsRoutes(app);
  // File upload/download (bytes go through REST, metadata through tRPC)
  registerFileRoutes(app);
  // Auth endpoints live in the tRPC auth router
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // Development serves through Vite; production serves the built files.
  //
  // The import has to be dynamic. A static one is resolved when the module
  // graph loads, before this condition is ever evaluated — so production would
  // import `vite`, which the production image doesn't install, and the process
  // would die on startup. It did exactly that, and only the Docker deployment
  // was affected because native installs carry devDependencies too.
  if (process.env.NODE_ENV === "development") {
    // The specifier is computed on purpose. esbuild bundles a *literal*
    // dynamic import of an internal module straight into the output, which
    // turns `vite`'s own import back into a static one at the top of the
    // bundle — exactly the crash this is avoiding. A variable specifier can't
    // be resolved at build time, so the module stays out of the graph and is
    // only loaded when this branch actually runs, under tsx, in development.
    const devServer = "./vite.ts";
    const { setupVite } = (await import(/* @vite-ignore */ devServer)) as
      typeof import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  let port = preferredPort;

  if (process.env.NODE_ENV === "production") {
    // In production the port is part of the deployment contract (Docker port
    // mapping, nginx upstream) — fail fast instead of silently moving.
    if (!(await isPortAvailable(preferredPort))) {
      console.error(`Port ${preferredPort} is not available. Exiting.`);
      process.exit(1);
    }
  } else {
    port = await findAvailablePort(preferredPort);
    if (port !== preferredPort) {
      console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
    }
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
  });
}

startServer().catch(console.error);
