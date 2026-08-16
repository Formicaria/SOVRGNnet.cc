import { buildSync } from "esbuild";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The production bundle must not import development-only packages.
 *
 * This exists because it happened. `server/_core/index.ts` statically imported
 * `./vite`, which imports `vite` and the Vite config, which imports the React
 * and Tailwind plugins. The *runtime* check was correct — Vite only starts in
 * development — but a static import is resolved when the module graph loads,
 * long before any condition runs.
 *
 * The production image installs with `--prod`, so `vite` isn't there, and the
 * container died immediately:
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite'
 *       imported from /app/dist/index.js
 *
 * Native installs were fine, because they install every dependency including
 * dev ones. The only broken deployment was the one nobody had ever booted
 * end-to-end — found by the e2e harness on its first run, not by review.
 *
 * Building here rather than trusting a committed artefact: the thing that
 * ships is the output of `pnpm build`, so that is what has to be checked.
 */

const ROOT = join(__dirname, "..");

/** Packages that exist only in devDependencies. */
const DEV_ONLY = [
  "vite",
  "@vitejs/plugin-react",
  "@tailwindcss/vite",
  "tailwindcss",
  "drizzle-kit",
  "esbuild",
  "vitest",
  "tsx",
  "typescript",
];

/**
 * Built with exactly the flags `pnpm build` uses, in memory.
 *
 * Mirroring the real command matters: `--packages=external` is what leaves
 * bare imports in the output, and it is the reason a static import of a
 * devDependency survives into production rather than being bundled away.
 */
function buildServerBundle(): string {
  const result = buildSync({
    entryPoints: [join(ROOT, "server", "_core", "index.ts")],
    platform: "node",
    packages: "external",
    bundle: true,
    format: "esm",
    write: false,
    absWorkingDir: ROOT,
  });
  return result.outputFiles[0].text;
}

describe("production server bundle", () => {
  const bundle = buildServerBundle();

  /** Bare specifiers the bundle imports at load time. */
  function staticImports(source: string): string[] {
    const found = new Set<string>();
    const pattern = /^\s*import\s+(?:[^;'"]*?\sfrom\s+)?["']([^"']+)["']/gm;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) found.add(specifier);
    }
    return [...found];
  }

  it("builds at all", () => {
    expect(bundle.length).toBeGreaterThan(1000);
  });

  it.each(DEV_ONLY)("does not statically import %s", pkg => {
    const imports = staticImports(bundle);
    const offending = imports.filter(s => s === pkg || s.startsWith(`${pkg}/`));
    expect(
      offending,
      `${pkg} is a devDependency and is absent from the production image — ` +
        `importing it statically kills the container on startup`
    ).toEqual([]);
  });

  it("keeps Vite behind a dynamic import esbuild cannot inline", () => {
    // Development still needs Vite; it just must not be in the static graph.
    //
    // The specifier has to stay a variable. A literal `import("./vite")` gets
    // bundled straight into the output, which puts vite's own import back at
    // the top as a static one — the bug this whole file exists for, reappearing
    // in a form that looks like the fix.
    expect(bundle).toMatch(/["']\.\/vite\.ts["']/);
    // esbuild keeps the /* @vite-ignore */ comment and wraps the call across
    // lines, so match the specifier inside the parentheses rather than a shape.
    expect(bundle).toMatch(/import\s*\([^)]*\bdevServer\b[^)]*\)/);

    // And the giveaway that it was inlined anyway: Vite's internals would be
    // in the output.
    expect(bundle).not.toMatch(/createViteServer|createServer as createViteServer/);
  });

  it("still imports the runtime dependencies it genuinely needs", () => {
    // Guards the test itself: a bundle importing nothing would pass every
    // assertion above while being completely broken.
    const imports = staticImports(bundle);
    expect(imports).toContain("express");
    expect(imports.length).toBeGreaterThan(5);
  });

  it("imports only packages that survive a --prod install", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const production = new Set(Object.keys(pkg.dependencies ?? {}));

    const unmet = staticImports(bundle)
      .filter(s => !s.startsWith("node:"))
      // Scoped and sub-path specifiers resolve to their package root.
      .map(s => (s.startsWith("@") ? s.split("/").slice(0, 2).join("/") : s.split("/")[0]))
      .filter(name => !production.has(name))
      // Node builtins without the prefix.
      .filter(name => !["fs", "path", "http", "https", "crypto", "os", "url", "util", "events", "stream", "zlib", "buffer", "net", "tls", "child_process"].includes(name));

    expect(
      unmet,
      "these are imported by the bundle but are not runtime dependencies"
    ).toEqual([]);
  });
});
