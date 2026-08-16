import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * Static checks on the end-to-end harness.
 *
 * The harness needs Docker, so it cannot run in the unit suite — which means
 * the failures it is most likely to have are the ones nobody sees until they
 * run it. A mistyped procedure name costs a full stack boot to discover, and
 * discovering it that way is exactly the friction that stops people running
 * verification at all.
 *
 * These assert the parts that can be checked without a container: that every
 * procedure the journey calls exists, that the harness cannot touch a real
 * instance, and that the backup it produces matches the format the verifier
 * reads.
 */

const ROOT = join(__dirname, "..");
const journey = readFileSync(join(ROOT, "scripts", "e2e-journey.ts"), "utf8");
const harness = readFileSync(join(ROOT, "scripts", "e2e.sh"), "utf8");
const backup = readFileSync(join(ROOT, "scripts", "e2e-backup.sh"), "utf8");

/** Every `router.procedure` path the tRPC router actually exposes. */
function routerPaths(): Set<string> {
  const paths = new Set<string>();
  const record = appRouter._def.procedures as Record<string, unknown>;
  for (const key of Object.keys(record)) paths.add(key);
  return paths;
}

/** Every procedure path the journey calls. */
function calledPaths(): string[] {
  const pattern = /["'`]([a-zA-Z]+\.[a-zA-Z]+)["'`]/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(journey)) !== null) {
    const candidate = match[1];
    // Only things that look like router paths, not file names or MIME types.
    if (/^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/.test(candidate)) found.add(candidate);
  }
  return [...found];
}

describe("the journey calls procedures that exist", () => {
  const available = routerPaths();
  const called = calledPaths();

  it("finds procedures in the router at all", () => {
    // Guards the test itself: if the introspection breaks, every assertion
    // below would pass vacuously.
    expect(available.size).toBeGreaterThan(20);
    expect(available.has("auth.register")).toBe(true);
  });

  it("finds calls in the journey at all", () => {
    expect(called.length).toBeGreaterThan(10);
  });

  it.each(calledPaths())("%s exists on the router", path => {
    expect(available.has(path), `${path} is not a procedure on appRouter`).toBe(true);
  });
});

describe("the harness cannot touch a real instance", () => {
  it("runs under its own compose project", () => {
    expect(harness).toMatch(/PROJECT="sovrgnnet-e2e"/);
  });

  it("routes every compose call through one function", () => {
    // The point is that -p cannot be forgotten on the command that deletes
    // volumes. Any bare `docker compose` would sidestep that.
    const bare = harness.match(/^\s*(docker compose|docker-compose|\$DC) /gm) ?? [];
    // $DC appears legitimately inside the compose() wrapper and in messages.
    expect(bare.filter(line => !line.includes("$DC")).length).toBe(0);
  });

  it("asserts the project name before removing volumes", () => {
    // Belt and braces, because `down -v` on the wrong project destroys a real
    // instance's data.
    expect(harness).toMatch(/\[ "\$PROJECT" = "sovrgnnet-e2e" \] \|\| die/);
  });

  it("uses a port that won't collide with a running instance", () => {
    expect(harness).toMatch(/E2E_PORT:-3999/);
  });

  it("generates its own secrets rather than reading a real .env", () => {
    expect(harness).toMatch(/mktemp/);
    expect(harness).toMatch(/DB_PASSWORD=\$\(secret\)/);
    // It must never fall back to the operator's environment file.
    expect(harness).not.toMatch(/--env-file \.env/);
  });
});

describe("the harness verifies what it claims to", () => {
  it("waits on /ready rather than just a listening port", () => {
    expect(harness).toMatch(/\/ready/);
    expect(harness).toMatch(/"ready":true/);
  });

  it("waits for the homeserver separately", () => {
    // Dendrite is slower than the app, and a journey that starts too early
    // fails on the first message send for a confusing reason.
    expect(harness).toMatch(/"matrix":"ok"/);
  });

  it("runs the conformance suite against the live stack", () => {
    expect(harness).toMatch(/conformance\.ts/);
  });

  it("actually destroys data before restoring", () => {
    // A restore that has never followed real data loss has never been tested.
    expect(harness).toMatch(/DROP SCHEMA public CASCADE/);
  });

  it("verifies the restore rather than assuming it worked", () => {
    expect(harness).toMatch(/E2E_MODE=verify-restore/);
    expect(journey).toMatch(/verify-restore/);
  });

  it("verifies the backup with the real verifier", () => {
    expect(harness).toMatch(/verify-backup\.sh/);
  });
});

describe("the harness backup matches the format the verifier reads", () => {
  it('writes format "sovbackup" at version 1', () => {
    expect(backup).toMatch(/"format": "sovbackup"/);
    expect(backup).toMatch(/"formatVersion": 1/);
  });

  it("derives the instance id the same way the server does", () => {
    // Must match instanceId() in server/instance.ts, or a restore onto a real
    // instance would look like a different server.
    expect(backup).toMatch(/sovrgnnet:instance:%s/);
    expect(backup).toMatch(/cut -c1-16/);
  });

  it("checksums every component", () => {
    expect(backup).toMatch(/sha256sum/);
  });

  it("names the same components the verifier expects", () => {
    for (const file of ["database.sql", "dendrite.sql", "ipfs_data.tar.gz", "env.backup"]) {
      expect(backup, `${file} missing from the manifest`).toContain(file);
    }
  });
});

describe("restore verification checks what actually matters", () => {
  it("proves the password hash survived, not just the row", () => {
    // Signing in is the only way to know the hash came back intact.
    expect(journey).toMatch(/auth\.login/);
    expect(journey).toMatch(/password still works/);
  });

  it("checks both users' messages", () => {
    expect(journey).toMatch(/the owner's message is gone/);
    expect(journey).toMatch(/the guest's message is gone/);
  });

  it("downloads the file rather than trusting the database row", () => {
    // Bytes live in IPFS and metadata in Postgres; each can be individually
    // fine while the pair disagrees.
    expect(journey).toMatch(/still downloadable/);
  });

  it("checks the administrator kept their role", () => {
    expect(journey).toMatch(/lost their role in the restore/);
  });
});
