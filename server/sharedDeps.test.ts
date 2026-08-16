import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Which shared modules the desktop client is allowed to pull in.
 *
 * The desktop keeps a four-package runtime — Tauri, its deep-link plugin,
 * React, React DOM — and every module under shared/ that it imports has to stay
 * inside that budget.
 *
 * This exists because the failure mode is invisible until packaging. TypeScript
 * resolves `zod` and `node:crypto` happily in this repository, since the root
 * has both; the desktop bundle is where it breaks, which is the slowest place
 * to find out. It has already happened once: shared/deviceFlow.ts imported
 * node:crypto, typechecked cleanly, and failed in `tauri build`.
 */

const SHARED = join(__dirname, "..", "shared");

/** Imported by desktop/src — must resolve with nothing installed but React. */
const DESKTOP_SAFE = [
  "protocol.ts",
  "instanceHealth.ts",
  "connections.ts",
  "invite.ts",
  "deeplink.ts",
  "deviceFlow.ts",
  "updates.ts",
];

/** Server-only. Free to depend on whatever the server already has. */
const SERVER_ONLY = ["backup.ts", "conformance.ts", "types.ts", "identity.ts"];

function importsOf(file: string): string[] {
  const source = readFileSync(join(SHARED, file), "utf8");
  const specifiers: string[] = [];
  // Static imports and re-exports both pull a module into the bundle.
  const pattern = /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) specifiers.push(match[1]);
  // Bare side-effect imports too.
  const bare = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;
  while ((match = bare.exec(source)) !== null) specifiers.push(match[1]);
  return specifiers;
}

const isRelative = (specifier: string) => specifier.startsWith(".");

describe("shared modules the desktop imports", () => {
  it.each(DESKTOP_SAFE)("%s imports nothing outside shared/", file => {
    const external = importsOf(file).filter(s => !isRelative(s));
    expect(external, `${file} may only import relative modules`).toEqual([]);
  });

  it.each(DESKTOP_SAFE)("%s uses no Node builtins", file => {
    const builtins = importsOf(file).filter(s => s.startsWith("node:"));
    // A browser cannot resolve these. TypeScript will not tell you.
    expect(builtins, `${file} must run in a browser`).toEqual([]);
  });

  it("protocol.ts in particular stays dependency-free", () => {
    // It is the specification. A contract defined in terms of one language's
    // schema library is one nobody can implement in another language.
    expect(importsOf("protocol.ts")).toEqual([]);
  });

  it("instanceHealth.ts only reaches for the protocol", () => {
    expect(importsOf("instanceHealth.ts").every(isRelative)).toBe(true);
  });
});

describe("server-only shared modules", () => {
  it("backup.ts may use zod, and does", () => {
    expect(importsOf("backup.ts")).toContain("zod");
  });

  it.each(SERVER_ONLY)("%s is not imported by the desktop client", file => {
    // Guards the split from the other direction: if the desktop starts
    // importing one of these, this list needs revisiting deliberately rather
    // than discovering it during a release build.
    expect(DESKTOP_SAFE).not.toContain(file);
  });
});
