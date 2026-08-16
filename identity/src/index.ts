import "dotenv/config";
import cookieParser from "cookie-parser";
import express from "express";
import { loadKeys } from "./keys";
import { mailTransportFromEnv } from "./mail";
import { registerRoutes } from "./routes";

/**
 * The SOVRGNnet identity provider.
 *
 * Small on purpose. It issues signed tokens and manages the accounts behind
 * them; it is not in the path of any conversation and holds nothing about
 * what happens on the servers that trust it.
 */

async function start() {
  // Fail at boot rather than on the first sign-in. A missing or malformed
  // signing key surfaces here as one clear message, not as mysterious
  // signature errors on other people's servers an hour later.
  const { active, all } = loadKeys();
  console.log(
    `[identity] signing with ${active.kid}` +
      (all.length > 1 ? `, also publishing ${all.length - 1} retired key(s)` : "")
  );

  const app = express();
  app.set("trust proxy", 1); // behind a reverse proxy or tunnel
  app.use(express.json({ limit: "64kb" }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  registerRoutes(app, mailTransportFromEnv());

  const port = Number(process.env.PORT ?? 4000);
  app.listen(port, () => {
    console.log(`[identity] listening on http://localhost:${port}`);
  });
}

start().catch(error => {
  console.error("[identity] failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
