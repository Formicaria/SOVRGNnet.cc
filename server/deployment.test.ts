import { readFileSync } from "node:fs";
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
