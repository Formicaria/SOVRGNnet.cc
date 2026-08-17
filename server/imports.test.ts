import { readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every package we import is one we declared.
 *
 * pnpm's node_modules is meant to be strict — a transitive dependency isn't
 * reachable unless you ask for it. "Meant to be" is doing work in that
 * sentence: depending on hoisting, a package pulled in by something else can
 * be resolvable locally and absent on a clean install. `loglevel` arrived that
 * way, via matrix-js-sdk. `tsc --noEmit` passed on the machine that wrote the
 * code and failed in CI, which is the worst place to find out and the reason
 * this file exists.
 *
 * A phantom dependency is also a real hazard rather than a hygiene point: the
 * version is whatever some other package happens to want today, and it can
 * vanish in a patch release of a package that has nothing to do with us.
 */

const ROOT = join(__dirname, "..");

// Only the root workspace. desktop/ and identity/ have their own package.json
// and their own CI jobs; checking them from here would read the wrong manifest
// and report every one of their legitimate dependencies as missing.
const SOURCE_DIRS = ["server", "shared", "scripts", "client/src"];

const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.devDependencies ?? {}),
]);

const builtins = new Set(builtinModules);

// tsconfig maps these to directories in the repo. They look like packages and
// are not.
const ALIASES = ["@/", "@shared/", "@assets/", "virtual:"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(ROOT, dir), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...sourceFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Import specifiers only.
 *
 * Deliberately anchored on the `import`/`export` keyword rather than matching
 * any quoted string after the word "from". A looser pattern reports prose —
 * a comment reading "different from 'the old behaviour'" parses as an import
 * of a package named `the old behaviour`, and a guard that cries wolf on
 * comments gets switched off.
 */
function specifiersIn(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[\s\S]*?\sfrom\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+(?:\*|\{[\s\S]*?\})\s*from\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.push(match[1]);
  }
  return found;
}

/** "@scope/name/sub" -> "@scope/name"; "name/sub" -> "name". */
function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

describe("no phantom dependencies", () => {
  it("imports only packages listed in package.json", () => {
    const offenders: string[] = [];

    for (const dir of SOURCE_DIRS) {
      for (const file of sourceFiles(dir)) {
        const text = readFileSync(join(ROOT, file), "utf8");
        for (const specifier of specifiersIn(text)) {
          if (specifier.startsWith(".") || specifier.startsWith("/")) continue;
          if (ALIASES.some((alias) => specifier.startsWith(alias))) continue;
          if (specifier.startsWith("node:")) continue;

          const name = packageOf(specifier);
          if (builtins.has(name) || declared.has(name)) continue;
          offenders.push(`${file} imports ${name}`);
        }
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  it("finds enough imports to be meaningful", () => {
    // If the patterns above ever stop matching, the test passes vacuously and
    // silently stops guarding anything.
    const total = SOURCE_DIRS.flatMap(sourceFiles).reduce(
      (count, file) => count + specifiersIn(readFileSync(join(ROOT, file), "utf8")).length,
      0
    );
    expect(total).toBeGreaterThan(200);
  });
});
