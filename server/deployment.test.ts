import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for claims docs/UPGRADING.md makes about the compose file.
 *
 * These two files drift apart silently: nothing breaks when a doc describes a
 * property the stack lost. UPGRADING.md claimed every image was "pinned by
 * digest" and that two operators on the same version "run the same bytes."
 * Neither was true — every image was pinned to a mutable version tag, and the
 * Dockerfile's base floats across every 22.x patch.
 *
 * A wrong upgrade doc is worse than no upgrade doc, because it is load-bearing
 * exactly when someone is debugging a difference between two machines that
 * claim to be identical.
 */

const ROOT = join(__dirname, "..");
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
const UPGRADING = readFileSync(join(ROOT, "docs/UPGRADING.md"), "utf8");

function images(): string[] {
  return [...COMPOSE.matchAll(/^\s*image:\s*(\S+)/gm)].map((m) => m[1]);
}

describe("compose images", () => {
  it("finds the images at all", () => {
    // If this drops to zero the other tests pass vacuously.
    expect(images().length).toBeGreaterThanOrEqual(5);
  });

  it("never uses a floating tag", () => {
    // `latest` and a bare name are the two ways to get a different Postgres
    // major on a restart you didn't plan. Dendrite migrates its schema forward
    // on boot, so an unplanned bump there is a one-way migration of the whole
    // message history with nobody watching.
    const floating = images().filter(
      (image) => !image.includes("@sha256:") && !/:[^:]+$/.test(image.split("/").pop()!)
    );
    const latest = images().filter((image) => image.endsWith(":latest"));
    expect([...floating, ...latest]).toEqual([]);
  });

  it("has no `:latest` in the deployment docs either", () => {
    // The compose file was pinned and docs/DEPLOYMENT.md still showed
    // `cloudflare/cloudflared:latest` in a snippet people copy. Checking only
    // the compose file made the rule true where it was enforced and false
    // where it was taught — and cloudflared is the one process with an
    // unsolicited path to the internet, so it was the worst place to leave a
    // floating tag.
    const offenders: string[] = [];
    for (const doc of ["docs/DEPLOYMENT.md", "docs/UPGRADING.md", "README.md"]) {
      const text = readFileSync(join(ROOT, doc), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        if (/^\s*image:\s*\S+:latest\s*$/.test(line)) {
          offenders.push(`${doc}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not claim digest pinning unless the images carry digests", () => {
    // The claim is fine to make. It just has to be earned first, and earning
    // it has a cost: digests stop base-layer CVE fixes arriving on their own,
    // so something has to bump them deliberately.
    //
    // Matching the two affirmative phrasings that were actually wrong, not
    // every way the claim could be worded. A looser pattern fired on the
    // paragraph explaining that the page used to say "the same bytes" — a
    // guard that cannot tell a claim from a correction of that claim is a
    // guard that punishes writing the correction down. This will miss a
    // rephrasing; it will not misread the retraction as a relapse.
    const claimsDigests = /pinned by digest in the compose|run the same bytes/i.test(UPGRADING);
    if (!claimsDigests) return;
    for (const image of images()) {
      expect(image, "UPGRADING.md claims digest pinning").toContain("@sha256:");
    }
  });
});

describe("sovrgnnet update --force", () => {
  const SCRIPT = readFileSync(join(ROOT, "sovrgnnet"), "utf8");

  // Comments stripped, because this file explains at length why it does not do
  // the dangerous thing — and a guard that reads the explanation as the deed
  // makes documenting the reasoning the thing that breaks the build. Crude
  // (a `#` inside a string would be cut too) but it only has to be right about
  // whether a command is present, and no command here contains one.
  const CODE = SCRIPT.split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

  it("never runs git clean", () => {
    // The reflex when writing a "force" update is to add `git clean -fdx` so
    // the tree matches the remote exactly. That would delete .env — the
    // database password, the JWT secret, the Matrix shared secret — because
    // .env is untracked by design.
    //
    // The result looks like a successful update and is an unrecoverable loss
    // of the instance's identity: MATRIX_SERVER_NAME is baked into every user
    // ID that exists, and restore refuses a server-name mismatch. There is no
    // version of "force" that should reach for this.
    expect(CODE).not.toMatch(/git\s+(-C\s+\S+\s+)?clean/);
  });

  it("takes a backup before resetting, and stops if it fails", () => {
    // --force discards work. The confirmation prompt is only honest if there
    // is something to go back to, so the backup is a precondition rather than
    // a suggestion, and a failed backup aborts before anything is touched.
    const forceBlock = CODE.slice(CODE.indexOf('if [ "$FORCE" -eq 1 ]'));
    const backupAt = forceBlock.indexOf("backup.sh");
    const resetAt = forceBlock.indexOf("reset --hard");
    expect(backupAt).toBeGreaterThan(-1);
    expect(resetAt).toBeGreaterThan(-1);
    expect(backupAt).toBeLessThan(resetAt);
    expect(forceBlock.slice(backupAt, resetAt)).toMatch(/\|\|\s*fail/);
  });

  it("refreshes cloudflared on native installs too", () => {
    // The compose pin only covers Docker installs. install-lxc.sh fetches the
    // cloudflared binary `if [ ! -x /usr/local/bin/cloudflared ]` — once, at
    // install time, never again. There is no pin to bump and no package
    // manager to report it stale, so a native box quietly runs whatever build
    // was current on the day it was created.
    const forceBlock = CODE.slice(CODE.indexOf('if [ "$FORCE" -eq 1 ]'));
    expect(forceBlock).toMatch(/cloudflared-linux-/);
    // Downloaded to a temp path and moved only on success: a failed download
    // must not leave a truncated binary where the working tunnel used to be.
    expect(forceBlock).toMatch(/-o \/tmp\/cloudflared\.new/);
    expect(forceBlock).toMatch(/mv \/tmp\/cloudflared\.new/);
  });

  it("re-pulls images rather than trusting the local cache", () => {
    // `up -d --build` alone reuses cached images, so a version tag rebuilt
    // upstream (an Alpine base-layer CVE fix) never actually arrives. Two
    // machines then report the same version while running different bytes —
    // which is precisely the property docs/UPGRADING.md no longer claims.
    expect(CODE).toMatch(/\$DC \$PROFILES pull/);
    expect(CODE).toMatch(/build --pull --no-cache/);
  });
});

describe("the control script and the native installer agree", () => {
  const SCRIPT = readFileSync(join(ROOT, "sovrgnnet"), "utf8");
  const INSTALLER = readFileSync(join(ROOT, "scripts/install-lxc.sh"), "utf8");

  it("manages exactly the units the installer creates", () => {
    // These two files are edited for different reasons months apart, and
    // nothing connects them. When Dendrite replaced Conduit the installer was
    // updated and this list was not, which under `set -e` meant `sovrgnnet
    // start` aborted on a unit that no longer existed — before starting the
    // app. A native install could not be started with its own control script.
    const declared = /NATIVE_UNITS="([^"]+)"/.exec(SCRIPT)?.[1].split(/\s+/) ?? [];
    expect(declared.length).toBeGreaterThan(0);

    const created = new Set(
      [...INSTALLER.matchAll(/systemd\/system\/([\w.-]+)\.service/g)].map((m) => m[1])
    );
    // postgresql comes from the distribution, not from us.
    const ours = declared.filter((unit) => unit !== "postgresql");
    for (const unit of ours) {
      expect(created, `${unit} is managed but never installed`).toContain(unit);
    }
  });
});

describe("the Conduit-to-Dendrite migration finishes", () => {
  const INSTALLER = readFileSync(join(ROOT, "scripts/install-lxc.sh"), "utf8");
  const DENDRITE = readFileSync(join(ROOT, "dendrite/dendrite.yaml.template"), "utf8");

  it("retires the old conduit unit before starting Dendrite", () => {
    // ADR 0006 replaced Conduit and handed Dendrite the same port, 6167. On a
    // machine installed before that, conduit.service still holds the port:
    // Dendrite crash-loops on "address already in use" while systemd reports
    // it as `activating` (Restart=always never lets it settle into `failed`),
    // and the old homeserver keeps answering under the old server name.
    //
    // Everything looks fine. That is the problem.
    const disableAt = INSTALLER.indexOf("disable --now conduit");
    const dendriteUnitAt = INSTALLER.indexOf("systemd/system/dendrite.service");
    expect(disableAt).toBeGreaterThan(-1);
    expect(disableAt).toBeLessThan(dendriteUnitAt);
    // Its database is not dropped: an installer does not get to delete
    // somebody's only copy of their history during an upgrade.
    expect(INSTALLER).not.toMatch(/dropdb\s+conduit/);
  });

  it("gives JetStream a durable storage path", () => {
    // Without one Dendrite picks a temp directory, and the unit sets
    // PrivateTmp=true — so the stream carrying events between Dendrite's own
    // components is wiped on every restart. The symptom is not a crash, it is
    // a message that was accepted and then never arrived.
    expect(DENDRITE).toMatch(/jetstream:\s*\n\s*storage_path:\s*\/var\/lib\/dendrite/);
  });
});

describe("scheduled backups", () => {
  const SCHEDULED = readFileSync(join(ROOT, "scripts/backup-scheduled.sh"), "utf8");
  const INSTALLER = readFileSync(join(ROOT, "scripts/install-lxc.sh"), "utf8");
  const CONTROL = readFileSync(join(ROOT, "sovrgnnet"), "utf8");

  it("prunes only after the copy, never before", () => {
    // Order is the whole design. Pruning first means a run that fails to
    // produce a good archive has already deleted the ones that were good —
    // the backup system becoming the thing that loses the data.
    const copyAt = SCHEDULED.indexOf("SOVRGN_BACKUP_DEST");
    const pruneAt = SCHEDULED.indexOf("rm -f \"$old\"");
    expect(copyAt).toBeGreaterThan(-1);
    expect(pruneAt).toBeGreaterThan(copyAt);
  });

  it("fails loudly rather than returning zero on a bad archive", () => {
    // systemd only surfaces a unit that exits non-zero. A backup job that
    // swallows its errors is worse than no backup job, because it also
    // produces the reassuring absence of alerts.
    expect(SCHEDULED).toMatch(/verify-backup\.sh[^\n]*\n\s*\|\| die/);
    expect(SCHEDULED).toMatch(/die\(\)\s*\{[^}]*exit 1/);
  });

  it("does not silently accept having nowhere to send the archive", () => {
    // Not fatal — refusing to back up because there is no offsite target
    // would be worse. But it says so on every run, and `sovrgnnet status`
    // shows it too, because a warning in a journal is not a warning.
    expect(SCHEDULED).toMatch(/WARNING: SOVRGN_BACKUP_DEST is unset/);
    expect(CONTROL).toMatch(/local only — set SOVRGN_BACKUP_DEST/);
  });

  it("installs a timer that catches up after downtime", () => {
    // Persistent=true. Without it a machine that was off at 03:20 skips the
    // day entirely and nothing anywhere records that it did.
    expect(INSTALLER).toContain("sovrgnnet-backup.timer");
    expect(INSTALLER).toMatch(/Persistent=true/);
  });

  it("reports the age of the last backup in status", () => {
    // The failure this guards is a backup that stopped running: no error, no
    // alert, just an archive that keeps getting older.
    expect(CONTROL).toContain("backup_line");
    expect(CONTROL).toMatch(/never taken/);
  });
});

describe("matrix delegation on the apex", () => {
  const README = readFileSync(join(ROOT, "site/.well-known/README.md"), "utf8");
  const CHECK = readFileSync(join(ROOT, "scripts/check-site.sh"), "utf8");
  const BUMP = readFileSync(join(ROOT, "scripts/bump-version.sh"), "utf8");

  const clientDelegation = join(ROOT, "site/.well-known/matrix/client");
  const serverDelegation = join(ROOT, "site/.well-known/matrix/server");

  it("always serves client delegation", () => {
    // True regardless of federation: a Matrix client resolving @you:sovrgnnet.cc
    // needs to be told which homeserver to log in to. Removing this breaks
    // every third-party client without breaking anything visible in the app.
    expect(existsSync(clientDelegation)).toBe(true);
    const doc = JSON.parse(readFileSync(clientDelegation, "utf8")) as {
      "m.homeserver": { base_url: string };
    };
    expect(doc["m.homeserver"].base_url).toMatch(/^https:\/\//);
  });

  it("documents that this file, not the app's route, is the live delegation", () => {
    // server/instanceRoutes.ts gates its own /.well-known/matrix/server on
    // MATRIX_ALLOW_FEDERATION, for a good reason written next to it. That gate
    // is bypassed whenever the server name and the app's hostname differ,
    // because delegation is always fetched from the server name — so on this
    // deployment the switch guards a route nobody asks.
    //
    // The gate is not wrong; it is the live delegation for an ordinary
    // single-hostname install. It just is not in the path here, and that is
    // the sort of thing that has to be written down or rediscovered.
    expect(README).toMatch(/app.*(own copy|has its own)/i);
    expect(README).toMatch(/MATRIX_ALLOW_FEDERATION/);
  });

  it("does not advertise federation the homeserver refuses", () => {
    // The static file cannot read the instance's config, so its presence is a
    // standing claim that federation is on. While it is off, following that
    // claim gets a remote server told exactly where to go and then refused.
    //
    // If federation is enabled, this test is what should change — restore the
    // file and update the README, together.
    if (existsSync(serverDelegation)) {
      expect(
        README,
        "matrix/server is present, so the README must stop describing it as absent"
      ).not.toMatch(/Absent on purpose/);
    }
  });

  it("check-site.sh looks at both", () => {
    expect(CHECK).toContain(".well-known/matrix/client");
    expect(CHECK).toContain(".well-known/matrix/server");
  });

  it("bumping the version updates the site too", () => {
    // v0.6.1 shipped with a site advertising v0.6.0 and download links
    // pointing at assets that do not exist under that tag. check-versions.sh
    // watches six manifests and the site is not one of them, because it is
    // HTML — which is exactly how it drifted.
    expect(BUMP).toMatch(/site --include=\*\.html/);
  });
});

describe("the servers do not announce their framework", () => {
  it("disables x-powered-by in both apps", () => {
    // Found by reading a response header from production: every reply carried
    // `x-powered-by: Express`. Not an exploit — but it names the framework to
    // every scanner that touches the origin, and the whole reason Express 4's
    // advisories are on the deferred list is that they are denial-of-service
    // issues somebody would have to decide to aim at us.
    //
    // Asserted in both, because the two apps are created in different files
    // and only one of them getting hardened is how this quietly comes back.
    for (const file of ["server/_core/index.ts", "identity/src/index.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect(text, file).toMatch(/app\.disable\(\s*["']x-powered-by["']\s*\)/);
    }
  });
});

describe("the version-bump pipeline", () => {
  const RENOVATE = JSON.parse(readFileSync(join(ROOT, "renovate.json"), "utf8")) as {
    packageRules?: Array<Record<string, unknown>>;
    automerge?: boolean;
    vulnerabilityAlerts?: { schedule?: string[] };
    schedule?: string[];
  };
  const RAW = readFileSync(join(ROOT, "renovate.json"), "utf8");

  it("never auto-merges anything", () => {
    // The whole argument in docs/UPGRADING.md is that nothing in this stack
    // should update itself: Postgres majors are one-way data-directory
    // migrations and Dendrite migrates its schema forward on boot. A bot that
    // merges its own PRs is Watchtower with extra steps.
    expect(RENOVATE.automerge).toBeUndefined();
    expect(RAW).not.toMatch(/"automerge"\s*:\s*true/);
    for (const rule of RENOVATE.packageRules ?? []) {
      expect(rule.automerge, JSON.stringify(rule.groupName)).not.toBe(true);
    }
  });

  it("does not make security advisories wait for the weekly window", () => {
    // Everything else is batched to Monday so the queue stays readable.
    // Applying that to advisories is a policy that works until the week it
    // doesn't.
    expect(RENOVATE.vulnerabilityAlerts?.schedule).toEqual(["at any time"]);
  });

  it("keeps cloudflared on its own, off-schedule", () => {
    // It is the only process in the compose file with an unsolicited path to
    // the internet, and it sat twenty months out of date while every other
    // signal looked healthy.
    const rule = (RENOVATE.packageRules ?? []).find((r) =>
      JSON.stringify(r.matchPackageNames ?? "").includes("cloudflared")
    );
    expect(rule).toBeDefined();
    expect(rule!.schedule).toEqual(["at any time"]);
  });

  it("groups the things that only work when moved together", () => {
    // Express with its transitive advisories; matrix-js-sdk with its Rust
    // bindings; Tauri's two package managers. Each of these produces a
    // green typecheck and a broken runtime when split.
    const groups = (RENOVATE.packageRules ?? [])
      .map((r) => String(r.groupName ?? ""))
      .join(" ");
    for (const expected of ["express", "matrix crypto stack", "tauri"]) {
      expect(groups, `missing group: ${expected}`).toContain(expected);
    }
  });

  it("flags the two bumps that need a migration plan", () => {
    const labelled = (RENOVATE.packageRules ?? []).filter((r) =>
      JSON.stringify(r.labels ?? []).includes("needs-migration-plan")
    );
    // Postgres majors and Dendrite. Both migrate data forward, one-way.
    expect(labelled.length).toBeGreaterThanOrEqual(2);
  });
});

describe("CI proves a dependency bump", () => {
  const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

  it("runs the full end-to-end harness somewhere", () => {
    // docs/UPGRADING.md claimed this before it was true. The app job runs the
    // unit suite against a real Postgres, which is most of the value — but it
    // never starts Dendrite, never builds the image, and never restores a
    // backup, so an image bump could go green without exercising a migration.
    expect(CI).toContain("./scripts/e2e.sh");
  });

  it("runs it on dependency pull requests specifically", () => {
    // The case the whole pipeline exists for. Gating on the label Renovate
    // applies means bumps are proven without every other PR paying the
    // minutes.
    expect(CI).toMatch(/pull_request\.labels\.\*\.name, 'dependencies'/);
  });

  it("counts the e2e result in the required check", () => {
    // A job nothing gates on is a job that can fail unnoticed. `ci` is the
    // single required status check, so it has to include this one.
    const gate = CI.slice(CI.indexOf("\n  ci:"));
    expect(gate).toContain("needs.e2e.result");
    expect(gate).toMatch(/needs:\s*\[[^\]]*e2e[^\]]*\]/);
  });
});

describe("route patterns Express 5 can parse", () => {
  /**
   * Every .ts under the repo, not a directory I guessed at.
   *
   * This exists because of the guess. Surveying the Express 5 migration I
   * grepped `server/*.ts` and `identity/src/*.ts`, found no wildcards, and
   * wrote in docs/DEPENDENCIES.md that route patterns were "the big one, and
   * clean". The app is created in `server/_core/`, which that pattern does not
   * reach, and two `app.use("*", …)` fallbacks were sitting there.
   *
   * Nothing caught it: it typechecks, every unit test passes, the image
   * builds. path-to-regexp v8 throws at *registration*, so the container came
   * up and the app simply never finished starting. Only the end-to-end stage
   * noticed.
   */
  function everySourceFile(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (["node_modules", "dist", ".git", "test-results"].includes(entry.name)) continue;
        out.push(...everySourceFile(join(dir, entry.name)));
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push(join(dir, entry.name));
      }
    }
    return out;
  }

  it("registers no bare wildcard or optional-parameter path", () => {
    // path-to-regexp v8 requires wildcards to be named — `*` is an error,
    // `*splat` is not — and dropped the `:param?` optional syntax entirely.
    const offenders: string[] = [];
    const registration =
      /\.(?:get|post|put|patch|delete|use|all)\(\s*["'`]([^"'`]*)["'`]/g;

    for (const file of everySourceFile(".")) {
      if (file.endsWith(".test.ts")) continue;
      // Comments stripped. Every version of this guard I have written today
      // first flagged the comment explaining why the thing is not done — this
      // file's own paragraph above quotes `app.use("*", …)` verbatim. A check
      // that cannot tell a registration from prose about one punishes writing
      // the reasoning down.
      const text = readFileSync(join(ROOT, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const match of text.matchAll(registration)) {
        const path = match[1];
        // A bare `*`, an unnamed `*` segment, or a `:param?` optional.
        if (/(^|\/)\*(?![A-Za-z_])/.test(path) || /:[A-Za-z_]\w*\?/.test(path)) {
          offenders.push(`${file}: ${JSON.stringify(path)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("searches the whole repository, not one directory", () => {
    // The bug was the scope of the search, so this is the assertion that
    // actually guards against a repeat.
    const files = everySourceFile(".");
    expect(files).toContain(join("server", "_core", "static.ts"));
    expect(files).toContain(join("server", "_core", "vite.ts"));
    expect(files.length).toBeGreaterThan(100);
  });
});

describe("the desktop and the web client show the same mark", () => {
  it("ships the identical file, not a copy that drifts", () => {
    // The desktop's first-run screen drew a gradient square with the letters
    // "SN" in it — a placeholder that shipped, on the first screen anybody
    // sees. Comparing bytes rather than existence: two marks that are
    // *nearly* the same is worse than one obviously missing, because nobody
    // notices until the two front doors are side by side.
    const web = readFileSync(join(ROOT, "client/src/assets/mark.png"));
    const desktop = readFileSync(join(ROOT, "desktop/src/assets/mark.png"));
    expect(desktop.equals(web)).toBe(true);
  });

  it("renders it as an image rather than typography", () => {
    const firstRun = readFileSync(join(ROOT, "desktop/src/components/FirstRun.tsx"), "utf8");
    expect(firstRun).toMatch(/<img[^>]*firstrun-mark/);
    // The placeholder, gone. Stripping comments because the one above it
    // quotes the old text.
    const code = firstRun
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/>\s*SN\s*</);
  });
});

describe("the identity route tests cannot reach production", () => {
  const HARNESS = readFileSync(join(ROOT, "identity/scripts/test-db.sh"), "utf8");
  const SUITE = readFileSync(join(ROOT, "identity/src/routes.db.test.ts"), "utf8");

  it("reads a variable the production environment does not set", () => {
    // The suite gates on IDENTITY_TEST_DATABASE_URL, not DATABASE_URL. If it
    // read the name the service itself uses, running it in a shell that had
    // sourced /opt/sovrgnnet/identity/.env would point a suite that truncates
    // tables at every identity on the network — and the failure would be
    // silent, total, and discovered afterwards.
    expect(SUITE).toContain("IDENTITY_TEST_DATABASE_URL");
    expect(SUITE).not.toMatch(/const TEST_DB = process\.env\.DATABASE_URL/);
  });

  it("skips rather than passing when there is no test database", () => {
    // A suite that needs a database and quietly reports success without one
    // is worse than no suite: it is a green tick standing in for coverage
    // that never ran.
    expect(SUITE).toMatch(/describe\.skip/);
    expect(SUITE).toMatch(/console\.warn/);
  });

  it("brings up its own Postgres on its own port", () => {
    // A different port and container name from the main server's, so both can
    // run at once and neither can be mistaken for the other.
    expect(HARNESS).toContain("sovrgnnet-identity-test-db");
    expect(HARNESS).toMatch(/IDENTITY_TEST_DB_PORT:-55433/);
    expect(HARNESS).toContain("docker run -d");
  });

  it("says out loud what pointing it at production would do", () => {
    expect(HARNESS).toMatch(/[Nn]ever against id\.sovrgnnet\.cc|not.*the live database/);
  });
});

describe("the harness stays out of a real node's way", () => {
  const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const E2E = readFileSync(join(ROOT, "scripts/e2e.sh"), "utf8");

  it("makes the IPFS swarm port overridable", () => {
    // Compose *appends* `ports` when an override file supplies its own, so a
    // port published in the base file cannot be removed by an override — only
    // given a different value. The harness picks its own project name and app
    // port to avoid collisions and inherited this one, so running it on a
    // machine that was also hosting a server failed on "address already in
    // use" with Docker naming a port and nothing naming the owner.
    expect(COMPOSE).toMatch(/\$\{IPFS_SWARM_PORT:-4001\}:4001\/tcp/);
    expect(COMPOSE).toMatch(/\$\{IPFS_SWARM_PORT:-4001\}:4001\/udp/);
  });

  it("defaults to 4001 for a real install", () => {
    // The swarm port is how a node peers with IPFS. Moving it by default
    // would quietly make every real install less connected.
    expect(COMPOSE).toContain("IPFS_SWARM_PORT:-4001");
  });

  it("moves it in the harness", () => {
    // The machine running the harness is usually the machine with a
    // desktop-hosted server open — that is what a developer's laptop looks
    // like — and a hermetic test has no business dialling the public network
    // anyway.
    expect(E2E).toMatch(/IPFS_SWARM_PORT=\$\{E2E_IPFS_SWARM_PORT:-14001\}/);
  });
});
