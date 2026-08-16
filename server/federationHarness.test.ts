import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * Static checks on the federation harness, in the same spirit as
 * e2eHarness.test.ts: the harness needs Docker and stands up *two* stacks, so
 * the mistakes it is most likely to carry — a mistyped procedure, a forgotten
 * project-name guard, an assertion that quietly checks nothing — cost two
 * stack boots to discover. These are the parts checkable without a container.
 */

const ROOT = join(__dirname, "..");
const journey = readFileSync(join(ROOT, "scripts", "e2e-federation-journey.ts"), "utf8");
const harness = readFileSync(join(ROOT, "scripts", "e2e-federation.sh"), "utf8");
const override = readFileSync(join(ROOT, "docker-compose.federation.yml"), "utf8");

function routerPaths(): Set<string> {
  const paths = new Set<string>();
  const record = appRouter._def.procedures as Record<string, unknown>;
  for (const key of Object.keys(record)) paths.add(key);
  return paths;
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function calledPaths(): string[] {
  const namespaces = new Set([...routerPaths()].map(p => p.split(".")[0]));
  const code = withoutComments(journey);
  const pattern = /["'`]([a-z][a-zA-Z]*)\.([a-z][a-zA-Z]*)["'`]/g;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    if (namespaces.has(match[1])) found.add(`${match[1]}.${match[2]}`);
  }
  return [...found];
}

describe("the federation journey calls procedures that exist", () => {
  const available = routerPaths();

  it("finds calls in the journey at all", () => {
    expect(calledPaths().length).toBeGreaterThan(5);
  });

  it.each(calledPaths())("%s exists on the router", path => {
    expect(available.has(path), `${path} is not a procedure on appRouter`).toBe(true);
  });
});

describe("the federation journey speaks the server's wire format", () => {
  it("wraps mutation input", () => {
    expect(journey).toMatch(/body:\s*JSON\.stringify\(\{\s*json:/);
  });

  it("wraps query input", () => {
    expect(journey).toMatch(/JSON\.stringify\(\{\s*json:\s*input\s*\}\)/);
  });

  it("unwraps the nested result", () => {
    expect(journey).toMatch(/"json"\s+in/);
  });

  it("reads the error message from where superjson puts it", () => {
    expect(journey).toMatch(/err\.json\?\.message/);
  });
});

describe("the federation harness cannot touch a real instance", () => {
  it("runs under its own two compose projects", () => {
    expect(harness).toMatch(/PROJECT_A="sovrgnnet-fed-a"/);
    expect(harness).toMatch(/PROJECT_B="sovrgnnet-fed-b"/);
  });

  it("asserts both project names before removing volumes", () => {
    expect(harness).toMatch(/\[ "\$PROJECT_A" = "sovrgnnet-fed-a" \] \|\| die/);
    expect(harness).toMatch(/\[ "\$PROJECT_B" = "sovrgnnet-fed-b" \] \|\| die/);
  });

  it("routes every compose call through the two wrappers", () => {
    const bare = harness.match(/^\s*(docker compose|docker-compose|\$DC) /gm) ?? [];
    expect(bare.filter(line => !line.includes("$DC")).length).toBe(0);
  });

  it("uses ports that collide with nothing else in this repo", () => {
    // 3000 is a real instance, 3999 is the e2e harness. Two more, distinct.
    expect(harness).toMatch(/FED_PORT_A:-4101/);
    expect(harness).toMatch(/FED_PORT_B:-4102/);
  });

  it("generates two independent secret sets rather than reading a real .env", () => {
    expect(harness).toMatch(/mktemp/);
    expect(harness).toMatch(/JWT_SECRET=\$\(secret\)/);
    expect(harness).not.toMatch(/--env-file \.env\b/);
  });

  it("only removes the shared network it created", () => {
    expect(harness).toMatch(/CREATED_NET=1/);
    expect(harness).toMatch(/\[ "\$CREATED_NET" -eq 1 \]/);
  });
});

describe("the two instances share a wire and nothing else", () => {
  it("only the homeserver joins the shared network", () => {
    // The override attaches `fednet` once — under matrix. An app or database
    // on the federation network would be two instances sharing what real
    // federated instances never share.
    const attachments = override.match(/^\s+fednet:\s*$/gm) ?? [];
    // Once under services.matrix.networks, once in the top-level declaration.
    expect(attachments.length).toBe(2);
  });

  it("declares the shared network external", () => {
    // A project-owned network dies with that project, taking the other
    // instance's federation link with it.
    expect(override).toMatch(/external: true/);
  });

  it("renames every container so two instances can coexist", () => {
    const names = override.match(/container_name: sovrgnnet-fed-\$\{FED_ID:\?\}-/g) ?? [];
    expect(names.length).toBe(4); // app, db, matrix, ipfs
  });

  it("opens the TLS listener the federation transport requires", () => {
    expect(override).toMatch(/--https-bind-address/);
    expect(override).toMatch(/--tls-cert/);
  });

  it("gives each instance its own JWT secret", () => {
    // Two instances sharing a JWT secret would be two instances trusting
    // each other's sessions — precisely not the situation under test.
    const perInstance = harness.match(/JWT_SECRET=\$\(secret\)/g) ?? [];
    expect(perInstance.length).toBeGreaterThanOrEqual(1);
    // And the env writer runs once per instance.
    expect(harness).toMatch(/write_env "\$ENV_A"/);
    expect(harness).toMatch(/write_env "\$ENV_B"/);
  });
});

describe("the harness render guards hold", () => {
  it("fails loudly if the template's TLS-validation line moves", () => {
    // The patch flips production values for the harness only. If the
    // template changes shape, the sed would silently no-op and federation
    // would fail far away from the cause.
    expect(harness).toMatch(/disable_tls_validation not found where expected/);
    expect(harness).toMatch(/prefer_direct_fetch not found where expected/);
  });

  it("fails loudly on an app_service_api collision, like e2e.sh does", () => {
    expect(harness).toMatch(/must stop appending its own/);
  });

  it("checks for unfilled placeholders", () => {
    expect(harness).toMatch(/__\[A-Z_\]\*__/);
  });
});

describe("the harness proves what ADR 0010 claims", () => {
  it("waits on /ready and the homeserver for both instances", () => {
    expect(harness).toMatch(/"ready":true/);
    expect(harness).toMatch(/"matrix":"ok"/);
  });

  it("asserts the index shape against both databases, not just the API", () => {
    // The quotes are shell-escaped in the harness source, so the pattern
    // matches what the file holds, not what psql eventually receives.
    expect(harness).toMatch(/\\"userId\\" IS NULL AND \\"senderMatrixId\\" LIKE/);
    expect(harness).toMatch(/\\"userId\\" IS NOT NULL AND \\"senderMatrixId\\" LIKE/);
  });

  it("says plainly where the splice is", () => {
    // The one non-product step. The day an attach surface exists, this
    // assertion is the reminder to replace the INSERT with it.
    expect(harness).toMatch(/no attach surface exists yet/);
  });

  it("runs conformance against both instances afterwards", () => {
    const runs = harness.match(/conformance\.ts "\$BASE_[AB]"/g) ?? [];
    expect(runs.length).toBe(2);
  });

  it("checks /metrics on both instances afterwards", () => {
    expect(harness).toMatch(/sovrgnnet_homeserver_up 1/);
  });

  it("journey: a federated sender is null userId plus a Matrix id", () => {
    expect(journey).toMatch(/userId === null/);
    expect(journey).toMatch(/senderMatrixId === state\.bobMatrixId/);
    expect(journey).toMatch(/senderMatrixId === state\.aliceMatrixId/);
  });

  it("journey: the same event is attributed locally on its home side", () => {
    expect(journey).toMatch(/userId === state\.bobId/);
  });

  it("journey: asserts the absence of invented history", () => {
    expect(journey).toMatch(/baselineText/);
    expect(journey).toMatch(/history it never received/);
  });

  it("journey: the redaction must clear both indexes", () => {
    expect(journey).toMatch(/clearing A's index/);
    expect(journey).toMatch(/crossing to B's index/);
  });

  it("journey: retries federation calls instead of asserting into the race", () => {
    // First contact between fresh homeservers includes key fetches that can
    // fail once and succeed on retry; a harness that flakes gets ignored.
    expect(journey).toMatch(/retryMatrix/);
    expect(withoutComments(journey)).not.toMatch(/unknown error/);
  });
});
