import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * Static checks on the staging verifier, in the harness-guard tradition:
 * it runs against a remote box, so its likeliest failures — a mistyped
 * procedure, a refusal that quietly stopped refusing — surface on somebody's
 * staging afternoon instead of in this suite. The production refusal gets the
 * closest scrutiny, because the whole reason the verifier exists is that
 * everything before it was verified against the live instance.
 */

const ROOT = join(__dirname, "..");
const journey = readFileSync(join(ROOT, "scripts", "staging-journey.ts"), "utf8");
const script = readFileSync(join(ROOT, "scripts", "verify-staging.sh"), "utf8");

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function calledPaths(): string[] {
  const namespaces = new Set(
    Object.keys(appRouter._def.procedures as Record<string, unknown>).map(p => p.split(".")[0])
  );
  const pattern = /["'`]([a-z][a-zA-Z]*)\.([a-z][a-zA-Z]*)["'`]/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  const code = withoutComments(journey);
  while ((match = pattern.exec(code)) !== null) {
    if (namespaces.has(match[1])) found.add(`${match[1]}.${match[2]}`);
  }
  return [...found];
}

describe("the staging journey calls procedures that exist", () => {
  const available = new Set(Object.keys(appRouter._def.procedures as Record<string, unknown>));

  it("finds calls at all", () => {
    expect(calledPaths().length).toBeGreaterThan(5);
  });

  it.each(calledPaths())("%s exists on the router", path => {
    expect(available.has(path), `${path} is not a procedure on appRouter`).toBe(true);
  });
});

describe("production is refused, twice, with names nobody can configure away", () => {
  it("the shell refuses production hostnames before running anything", () => {
    for (const host of ["sovrgnnet.cc", "app.sovrgnnet.cc"]) {
      expect(script.includes(host), `verify-staging.sh no longer refuses ${host}`).toBe(true);
    }
    expect(script).toMatch(/That is production/);
  });

  it("the journey refuses by the instance's own reported server name", () => {
    // A production box reached by IP sails past a hostname check; the
    // descriptor check is the one that catches it.
    expect(journey).toMatch(/PRODUCTION_SERVER_NAMES\s*=\s*\["sovrgnnet\.cc"\]/);
    expect(journey).toMatch(/that is production, reached by another name/i);
  });

  it("neither refusal reads from the environment", () => {
    // The refusal lists are hardcoded because a configurable refusal is a
    // refusal someone configures away. Nothing may feed them from env.
    const code = withoutComments(journey);
    expect(code).not.toMatch(/PRODUCTION_SERVER_NAMES\s*=\s*[^[]*process\.env/);
    expect(code).not.toMatch(/PRODUCTION_HOSTS\s*=\s*[^[]*process\.env/);
  });
});

describe("the journey adapts to the instance instead of assuming the harness", () => {
  it("branches on the advertised e2ee capability, asserting both honesty directions", () => {
    expect(journey).toMatch(/e2ee is advertised but the new channel is plaintext/);
    expect(journey).toMatch(/e2ee is not advertised but the channel claims encryption/);
  });

  it("only exercises direct sync when clientMatrix is advertised", () => {
    expect(journey).toMatch(/capabilities\.clientMatrix === true/);
  });

  it("requires exactly one auth mode", () => {
    expect(journey).toMatch(/exactly one mode/i);
  });

  it("asserts the invite names the instance it came from", () => {
    // The lanHost passthrough case, checked from the outside: on a box with
    // a real hostname, the invite must carry that hostname untouched.
    expect(journey).toMatch(/invite names .* but this instance is/);
  });
});
