import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
// First-party auth: session cookie resolved in createContext
import { appRouter } from "../routers";
import { registerFileRoutes } from "../fileRoutes";
import { registerInstanceRoutes } from "../instanceRoutes";
import { runMigrations, waitForDatabase } from "../migrate";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

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
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  // Public identity: how a client that has never seen this server finds out
  // what it is. Registered before auth-bearing routes because none of it
  // requires a session.
  registerInstanceRoutes(app);
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
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
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
