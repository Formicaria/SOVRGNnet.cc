import { type Express } from "express";
import fs from "fs";
import { type Server } from "http";
import { nanoid } from "nanoid";
import path from "path";
import { createServer as createViteServer } from "vite";
import viteConfig from "../../vite.config";

/**
 * Development-only. Never import this module from a path that runs in
 * production — `vite` is a devDependency and is absent from the production
 * image, so merely resolving this file there kills the process.
 *
 * index.ts imports it dynamically, inside the development branch. serveStatic
 * lives in ./static.ts precisely so production never touches this file.
 */
export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
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
  app.use(async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "../..",
        "client",
        "index.html"
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

// serveStatic moved to ./static.ts — see the note there. Keeping it here meant
// production imported this module, and therefore imported Vite.
