import express, { type Express } from "express";
import fs from "fs";
import path from "path";

/**
 * Serve the built client.
 *
 * Deliberately in its own module, importing nothing from Vite.
 *
 * It used to live in vite.ts beside setupVite, and index.ts imported both
 * statically. The *runtime* check was correct — Vite is only started in
 * development — but a static import is resolved when the module graph loads,
 * long before any condition is evaluated. So the production bundle imported
 * `vite`, the production image installs with --prod and doesn't have it, and
 * the container died on startup with ERR_MODULE_NOT_FOUND.
 *
 * Native installs were unaffected, because they install every dependency
 * including dev ones. That is why this survived: the deployment that broke was
 * the one nobody had booted end-to-end.
 */
export function serveStatic(app: Express): void {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // Fall through to index.html so client-side routes resolve on a hard refresh.
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
