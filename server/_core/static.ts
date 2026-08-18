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
  // No path, rather than "*". Express 5 routes through path-to-regexp v8,
  // where a bare "*" is a wildcard with no name and throws at registration:
  // `Missing parameter name at index 1: *`. The app then never finishes
  // starting, which is how this surfaced — the container came up, the
  // healthcheck never passed, and nothing typechecked any differently.
  //
  // `app.use(handler)` and `app.use("*", handler)` have always meant the same
  // thing: run for every request that reaches here. Dropping the path keeps
  // the behaviour and takes the pattern out of path-to-regexp's hands
  // entirely, which is better than translating it to "/*splat".
  app.use((_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
