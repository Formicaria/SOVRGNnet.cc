/**
 * Static checks on the authenticated conformance runner.
 *
 * Same reasoning as e2eHarness.test.ts, sharpened by what this runner is for:
 * an operator points it at a LIVE instance. A mistyped procedure path would
 * cost them a run that writes rows before failing — and the rows are the part
 * that can't be taken back. Everything statically checkable gets checked
 * here, without booting anything.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { checkUsername } from "@shared/username";
import { isValidInviteCode } from "@shared/invite";

const ROOT = join(__dirname, "..");
const runner = readFileSync(join(ROOT, "scripts", "conformance-auth.ts"), "utf8");

/** Comment text stripped, so assertions match code and never prose about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function routerPaths(): Set<string> {
  const record = appRouter._def.procedures as Record<string, unknown>;
  return new Set(Object.keys(record));
}

/** Every procedure path the runner hands to query()/mutate(). */
function calledPaths(): string[] {
  const code = withoutComments(runner);
  const calls = [...code.matchAll(/\.(?:query|mutate)\(\s*"([^"]+)"/g)].map(m => m[1]);
  return [...new Set(calls)];
}

describe("conformance-auth runner", () => {
  it("only calls procedures the router actually exposes", () => {
    const real = routerPaths();
    const missing = calledPaths().filter(path => !real.has(path));
    expect(missing).toEqual([]);
  });

  it("actually exercises the surface it claims to (auth, membership, roles, invites)", () => {
    // The inverse of the check above: a runner that calls nothing also calls
    // nothing that doesn't exist. Pin the corners of the claimed coverage.
    const called = new Set(calledPaths());
    for (const path of [
      "auth.register",
      "auth.login",
      "auth.me",
      "auth.logout",
      "servers.create",
      "servers.createInvite",
      "servers.joinByInvite",
      "servers.getById",
      "channels.create",
      "messages.listByChannel",
      "messages.send",
      "messages.delete",
      "serverMembers.setRole",
    ]) {
      expect(called.has(path), `runner never calls ${path}`).toBe(true);
    }
  });

  it("refuses to run without the operator acknowledgment", () => {
    // The gate is the safety boundary between this suite and its read-only
    // sibling. It must be checked, and refusal must be an exit before any
    // session exists to write with.
    const code = withoutComments(runner);
    expect(code).toContain("--i-operate-this-instance");
    const gate = code.indexOf("acknowledged");
    const firstWrite = code.indexOf('mutate("auth.register"');
    expect(gate).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(gate);
  });

  it("names everything it creates with the conformance- prefix", () => {
    // The containment promise: rows this suite leaves behind are greppable.
    expect(runner).toContain("`conformance-${stamp}-a`");
    expect(runner).toContain("`conformance-${stamp}-b`");
    expect(runner).toContain("conformance ${stamp}");
  });

  it("generates usernames the instance will accept", () => {
    // The runner's literal naming scheme, evaluated the way the server will.
    // Drift in username rules should fail here, not mid-run against staging.
    const stamp = Date.now().toString(36);
    for (const name of [`conformance-${stamp}-a`, `conformance-${stamp}-b`]) {
      const checked = checkUsername(name);
      expect(checked.ok, `${name}: ${checked.ok ? "" : checked.message}`).toBe(true);
    }
  });

  it("probes invites with codes on the right side of the validator", () => {
    // The uniform-404 check needs codes that PASS validation (so they reach
    // the lookup) and the malformed check needs one that FAILS it. If the
    // validator's pattern moves, this is where that surfaces.
    expect(isValidInviteCode("0".repeat(10))).toBe(true);
    expect(isValidInviteCode("1".repeat(10))).toBe(true);
    expect(isValidInviteCode("x".repeat(64))).toBe(false);
  });

  it("sends a password long enough to register with", () => {
    // registerCredentials demands min(8). The generated password is
    // `conf-<stamp>-<8 random chars>`, always comfortably past it; assert the
    // template survives edits.
    expect(runner).toMatch(/PASSWORD = `conf-\$\{stamp\}-/);
  });

  it("is exercised by the e2e stage, with the acknowledgment and both accounts", () => {
    // The suite an operator is told to trust must have walked its own deep
    // path on the throwaway stack. If this wiring disappears from e2e.sh,
    // conformance-auth goes back to compiled-but-never-run — the exact
    // pattern the last several releases kept paying for.
    const e2e = readFileSync(join(ROOT, "scripts", "e2e.sh"), "utf8")
      .replace(/^\s*#.*$/gm, "");
    expect(e2e).toContain("scripts/conformance-auth.ts");
    expect(e2e).toContain("--i-operate-this-instance");
    expect(e2e).toContain("--user-a=");
    expect(e2e).toContain("--user-b=");
  });
});
