import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPONENTS, INSTALL_STEPS, PREFERRED_PORTS } from "@shared/hosting";

/**
 * Static checks on the desktop hosting stack — ADR 0005's seams.
 *
 * The supervisor is Rust, the bundle is assembled by bash, the resources are
 * declared in JSON, the wiring runs in CI YAML, and the policy is TypeScript.
 * Those five only meet on a release runner, which is the most expensive
 * possible place to discover they disagree about a filename. Every agreement
 * they depend on is asserted here instead, in the suite that runs on every
 * push — the same treatment e2eHarness.test.ts and federationHarness.test.ts
 * give their scripts.
 */

const ROOT = join(__dirname, "..");
const supervisor = readFileSync(join(ROOT, "desktop", "src-tauri", "src", "hosting.rs"), "utf8");
const shell = readFileSync(join(ROOT, "desktop", "src-tauri", "src", "main.rs"), "utf8");
const bundleScript = readFileSync(join(ROOT, "scripts", "host-bundle.sh"), "utf8");
const tauriConf = JSON.parse(
  readFileSync(join(ROOT, "desktop", "src-tauri", "tauri.conf.json"), "utf8")
) as { bundle?: { resources?: Record<string, string> } };
const releaseYml = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
const ciYml = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const dendriteTemplate = readFileSync(join(ROOT, "dendrite", "dendrite.yaml.template"), "utf8");
const bridge = readFileSync(join(ROOT, "desktop", "src", "lib", "hosting.ts"), "utf8");

describe("the supervisor and the policy layer agree", () => {
  it("emits exactly the install steps the policy names", () => {
    // A step the Rust side emits but the UI can't label renders as a blank
    // progress line; a step the UI expects but Rust never emits stalls the
    // count. Same set, both directions.
    const emitted = new Set(
      [...supervisor.matchAll(/emit_step\(&?app, "([a-z]+)"\)/g)].map(m => m[1])
    );
    for (const step of INSTALL_STEPS) {
      expect(emitted.has(step.id), `hosting.rs never emits step "${step.id}"`).toBe(true);
    }
    for (const id of emitted) {
      expect(
        INSTALL_STEPS.some(step => step.id === id),
        `hosting.rs emits "${id}", which INSTALL_STEPS doesn't name`
      ).toBe(true);
    }
  });

  it("reports the component ids the policy evaluates", () => {
    for (const id of COMPONENTS) {
      expect(supervisor.includes(`"${id}"`), `hosting.rs never mentions component "${id}"`).toBe(
        true
      );
    }
  });

  it("hardcodes no ports — candidates come from TypeScript", () => {
    // The whole point of PortPlan is that policy owns port preferences. A
    // literal port in the Rust would win silently on one platform and drift.
    for (const port of Object.values(PREFERRED_PORTS)) {
      expect(supervisor.includes(String(port)), `hosting.rs hardcodes port ${port}`).toBe(false);
    }
  });

  it("the frontend sends candidates for every component", () => {
    for (const id of COMPONENTS) {
      expect(bridge).toContain(`${id}: portCandidates("${id}")`);
    }
  });
});

describe("the supervisor and the bundle script agree on names", () => {
  // The supervisor's idea of the bundle layout, extracted from the code that
  // reads it. If a name changes on either side, this is the failure — not a
  // spawn error inside an installer on somebody's machine.
  const expectations = [
    "dendrite",
    "generate-keys",
    "kubo",
    "node",
    "dendrite.yaml.template",
  ];

  it.each(expectations)('both sides know "%s"', name => {
    expect(supervisor.includes(`"${name}"`), `hosting.rs doesn't reference ${name}`).toBe(true);
    expect(bundleScript.includes(name), `host-bundle.sh doesn't produce ${name}`).toBe(true);
  });

  it("the app entry point matches", () => {
    expect(supervisor).toContain('"index.mjs"');
    expect(bundleScript).toContain("app/index.mjs");
  });

  it("postgres tools are under postgres/bin on both sides", () => {
    // The property is the *directory*, not one tool's name. This asserted
    // `postgres/bin/initdb` literally, and broke the moment the bundle script
    // started checking four tools through a loop variable — a change that
    // strengthened exactly what this test was protecting.
    //
    // Second time a guard here has failed on the spelling rather than the
    // thing: an earlier one demanded `matrix_server_name(` inline and tripped
    // on a call site that legitimately used a variable.
    expect(supervisor).toMatch(/join\("postgres"\)\.join\("bin"\)/);
    expect(bundleScript).toMatch(/postgres\/bin\//);
  });

  it("the bundle script builds what the compose file pins", () => {
    // A desktop-hosted server and a Docker one should run the same versions.
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    const kuboPin = compose.match(/ipfs\/kubo:v([\d.]+)/)?.[1];
    const dendritePin = compose.match(/dendrite-monolith:v([\d.]+)/)?.[1];
    expect(kuboPin, "compose no longer pins kubo where this test looks").toBeTruthy();
    expect(dendritePin, "compose no longer pins dendrite where this test looks").toBeTruthy();
    expect(bundleScript).toContain(`KUBO_VERSION="\${HOST_KUBO_VERSION:-${kuboPin}}"`);
    expect(bundleScript).toContain(`DENDRITE_TAG="\${HOST_DENDRITE_TAG:-v${dendritePin}}"`);
  });
});

describe("the shell registers what the frontend invokes", () => {
  it("every invoke() in the desktop UI has a matching command", () => {
    const registered = new Set(
      [...shell.matchAll(/^\s*(?:hosting::)?([a-z_]+),?\s*$/gm)]
        .map(m => m[1])
        .concat([...shell.matchAll(/fn ([a-z_]+)\(/g)].map(m => m[1]))
    );
    // The generate_handler block lists them; fn definitions confirm them.
    const uiFiles = ["lib/bridge.ts", "lib/hosting.ts"].map(f =>
      readFileSync(join(ROOT, "desktop", "src", f), "utf8")
    );
    const invoked = new Set(
      uiFiles.flatMap(source => [...source.matchAll(/invoke(?:<[^>]*>)?\("([a-z_]+)"/g)].map(m => m[1]))
    );
    expect(invoked.size).toBeGreaterThan(5);
    for (const command of invoked) {
      expect(registered.has(command), `frontend invokes "${command}", shell doesn't define it`).toBe(
        true
      );
    }
  });

  it("stops the hosted server when the app exits", () => {
    expect(shell).toMatch(/RunEvent::Exit/);
    expect(shell).toMatch(/stop_all/);
  });
});

describe("the supervisor renders the real dendrite template", () => {
  it("replaces every placeholder the template defines", () => {
    const placeholders = new Set(
      [...dendriteTemplate.matchAll(/^(?!\s*#).*?(__[A-Z_]+__)/gm)].map(m => m[1])
    );
    expect(placeholders.size).toBeGreaterThanOrEqual(4);
    for (const placeholder of placeholders) {
      expect(
        supervisor.includes(`"${placeholder}"`),
        `dendrite.yaml.template has ${placeholder}; hosting.rs never fills it — ` +
          `a desktop-hosted homeserver would refuse its config`
      ).toBe(true);
    }
  });

  it("ships the template into the bundle", () => {
    expect(bundleScript).toContain("dendrite/dendrite.yaml.template");
  });
});

describe("CI actually builds and checks all of it", () => {
  it("release assembles the host bundle for linux and windows", () => {
    expect(releaseYml).toContain("scripts/host-bundle.sh");
    expect(releaseYml).toMatch(/windows-x64/);
    expect(releaseYml).toMatch(/linux-x64/);
  });

  it("release sets up Go, which the dendrite build needs", () => {
    expect(releaseYml).toContain("actions/setup-go");
  });

  it("tauri bundles the host directory as resources", () => {
    expect(tauriConf.bundle?.resources?.host).toBe("host");
  });

  it("the shell's Rust is checked on push, on both shipping platforms", () => {
    // The v0.5.0 rule: code that first compiles during a release fails
    // during a release.
    expect(ciYml).toContain("desktop-rust:");
    expect(ciYml).toMatch(/cargo check --locked/);
    expect(ciYml).toMatch(/\[ubuntu-22\.04, windows-latest\]/);
  });
});

describe("what the person is told stays honest", () => {
  it("a bundle-less build says it can't host rather than failing later", () => {
    expect(supervisor).toContain("ships without server components");
  });

  it("secrets never take a disk path through the supervisor", () => {
    // The one exception is initdb's pwfile, which must be removed in the
    // same breath it's used.
    expect(supervisor).toMatch(/remove_file\(&pwfile\)/);
    // And nothing writes the JWT or shared secret to a file: they only ever
    // appear as env() arguments or inside the rendered homeserver config,
    // which is the component's own required format.
    expect(supervisor).not.toMatch(/write.*jwt/i);
  });

  it("the release notes state the hosting claim per platform", () => {
    expect(releaseYml).toContain("The Linux .deb and Windows installers can also host.");
    expect(releaseYml).toContain("The AppImage and macOS builds are client-only");
  });

  it("the AppImage is built without the host bundle, deliberately", () => {
    // linuxdeploy resolves every ELF in the AppDir and cannot digest a full
    // PostgreSQL tree — v0.6.0's first build proved it. The AppImage build
    // must empty host/ first, and the config must not list appimage in the
    // default targets where the resources would ride along.
    expect(releaseYml).toContain("pnpm tauri build --bundles appimage");
    expect(releaseYml).toMatch(/rm -rf src-tauri\/host/);
    expect(tauriConf).toBeTruthy();
    const targets = (
      tauriConf as unknown as { bundle?: { targets?: string[] } }
    ).bundle?.targets;
    expect(targets).not.toContain("appimage");
  });
});

describe("each desktop host gets its own Matrix identity", () => {
  it("never hands a hardcoded server name to Dendrite or the app", () => {
    // Both used to read "sovrgn.host" literally, and that one shared string
    // took two security guards down with it: instance ids are a hash of this
    // value and identity tokens are audience-bound to the instance id, so a
    // token for one desktop verified on all of them; and backup restore
    // compares server names, so the check that stops a restore onto the wrong
    // machine passed between strangers.
    //
    // The literal still appears in the file — in the grandfathering branch and
    // in comments — so this asserts on the *call sites* rather than the file.
    for (const line of supervisor.split("\n")) {
      if (!line.includes("MATRIX_SERVER_NAME")) continue;
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("///")) continue;

      // The property is "no hardcoded name reaches a component", not "the call
      // is inline" — one of these two sites reads a variable assigned from
      // matrix_server_name() a few lines earlier, and demanding the call on the
      // same line rejected correct code. So: strip the key's own name, and
      // assert nothing quoted is left to be a value.
      const withoutKey = line
        .replace(/"__MATRIX_SERVER_NAME__"/g, "")
        .replace(/"MATRIX_SERVER_NAME"/g, "");
      expect(
        withoutKey,
        "a literal server name is being handed to a component — it must come from matrix_server_name()"
      ).not.toMatch(/"[^"]+"/);
    }
  });

  it("agrees with the frontend on the field name", () => {
    // A serde seam. The Rust struct deserializes what the webview sends, so a
    // rename on one side is a silently empty string on the other — and an empty
    // proposed name is indistinguishable from "an older install" unless you
    // already know to look.
    expect(supervisor).toMatch(/pub matrix_server_name: String/);
    expect(bridge).toMatch(/matrix_server_name: string/);
    expect(bridge).toMatch(/matrix_server_name: freshServerName\(\)/);
  });

  it("proposes a well-formed hostname that isn't the shared one", () => {
    // Matrix IDs embed the server name permanently, so a malformed one is not a
    // bug to fix later — every ID minted under it is already wrong.
    const suffix = /`\$\{randomHex\((\d+)\)\}\.desktop\.sovrgn\.host`/.exec(bridge);
    expect(suffix, "freshServerName no longer builds a .desktop.sovrgn.host name").toBeTruthy();
    // Enough randomness that two machines colliding — which would recreate the
    // exact bug this replaced — is not something to think about.
    expect(Number(suffix![1])).toBeGreaterThanOrEqual(8);
  });

  it("keeps the decision in Rust, next to the data directory", () => {
    // The frontend proposes; only the supervisor can see whether this machine
    // has hosted before, and renaming an install that already has a Dendrite
    // database orphans every account and room in it.
    expect(supervisor).toMatch(/matrix-server-name/);
    const code = supervisor;
    const readsFile = code.indexOf("read_to_string(&path)");
    const writesFile = code.indexOf("std::fs::write(&path");
    expect(readsFile).toBeGreaterThan(-1);
    // Read before write: the whole correctness argument is that an existing
    // name always wins.
    expect(writesFile).toBeGreaterThan(readsFile);
  });
});

describe("the host bundle ships what hosting.rs spawns", () => {
  const HOSTING = readFileSync(
    join(__dirname, "..", "desktop/src-tauri/src/hosting.rs"),
    "utf8"
  );
  const BUNDLE = readFileSync(join(__dirname, "..", "scripts/host-bundle.sh"), "utf8");

  /** Every `postgres_bin(app, "x")` in the supervisor. */
  function spawned(): string[] {
    return [
      ...new Set(
        [...HOSTING.matchAll(/postgres_bin\(&?app,\s*"([a-z_]+)"\)/g)].map((m) => m[1])
      ),
    ].sort();
  }

  it("finds the binaries it spawns", () => {
    // Names, not a count. This asserted `>= 4` and broke the moment `createdb`
    // was removed — a change that fixed the very bug the suite was written
    // for. A magic number goes stale every time the set it describes changes,
    // which is exactly when you least want a red test you have to think about.
    expect(spawned()).toEqual(["initdb", "pg_ctl", "postgres"]);
  });

  it("ships the database-creation script the supervisor spawns", () => {
    // The one binary that was missing is now not a binary. zonky's
    // embedded-postgres omits the client tools on Windows and Linux and
    // includes them on macOS, so `createdb` was present when the bundle was
    // built on a Mac and absent on the machine that ran it.
    expect(HOSTING).toContain("createdbs.mjs");
    expect(BUNDLE).toContain("host-createdbs.ts");
    expect(BUNDLE).toContain("createdbs.mjs");
  });

  it("no longer spawns createdb at all", () => {
    // If something reintroduces it, the bundle check below will not catch it —
    // `createdb` was deliberately dropped from the verified list because it
    // cannot be verified. So catch it here instead.
    const code = HOSTING.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/"createdb"/);
  });

  it("verifies every one of them at build time", () => {
    // A Windows build shipped without `createdb`. The bundle script checked
    // `initdb` and stopped there, so the missing file surfaced on a user's
    // machine, three steps into a first run:
    //
    //   createdb sovrgnnet: couldn't run: The system cannot find the file
    //   specified. (os error 2)
    //
    // The failure belongs where the fix is — re-running host-bundle.sh — not
    // in front of somebody trying to start a server.
    for (const tool of spawned()) {
      expect(BUNDLE, `host-bundle.sh never checks for ${tool}`).toContain(tool);
    }
  });

  it("refuses to offer hosting unless all of them are present", () => {
    // bundle_present() decides whether the app offers to host at all. It
    // checked initdb alone, so a bundle missing createdb still advertised
    // itself as able to host.
    const guard = HOSTING.slice(
      HOSTING.indexOf("fn bundle_present"),
      HOSTING.indexOf("fn bundle_present") + 700
    );
    for (const tool of spawned()) {
      expect(guard, `bundle_present ignores ${tool}`).toContain(`"${tool}"`);
    }
  });
});
