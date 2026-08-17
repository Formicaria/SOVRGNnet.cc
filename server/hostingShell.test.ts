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
    expect(supervisor).toMatch(/join\("postgres"\)\.join\("bin"\)/);
    expect(bundleScript).toMatch(/postgres\/bin\/initdb/);
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
