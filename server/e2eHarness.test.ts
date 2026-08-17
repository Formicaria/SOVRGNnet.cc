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

/** Comment text, so assertions about the code don't match prose about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * The same, for shell.
 *
 * Needed the moment a comment started *quoting* the code it replaced — an
 * assertion that a bad pattern is absent will match the comment explaining why
 * it was removed, and fail on the documentation rather than the behaviour.
 */
function withoutShellComments(source: string): string {
  return source.replace(/^\s*#.*$/gm, "");
}

/**
 * Every procedure path the journey calls.
 *
 * Restricted to strings whose first segment is a real router namespace.
 * Matching any `word.word` in quotes pulled in things like "error.message" and
 * asserted they were procedures, which is a test failing on its own sloppiness
 * rather than on a problem.
 */
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
    expect(available.has(path), `${path} is not a procedure on appRouter`).toBe(
      true
    );
  });
});

describe("the journey speaks the wire format the server actually uses", () => {
  // The server sets superjson as its tRPC transformer, so input and output are
  // both wrapped in { json: ... }. The journey sent raw input, every call
  // failed validation with "expected object, received undefined", and the
  // error — also wrapped — surfaced as "unknown error".
  //
  // Verified against the live router before writing these: wrapped input
  // validates real values, raw input produces exactly that error, and success
  // comes back as {"result":{"data":{"json":...}}}.

  it("the server does configure a transformer", () => {
    // If this stops being true the wrapping becomes wrong, not merely
    // unnecessary — so it's worth failing loudly rather than drifting.
    const trpc = readFileSync(join(ROOT, "server", "_core", "trpc.ts"), "utf8");
    expect(trpc).toMatch(/transformer:\s*superjson/);
  });

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

  it("never reports a failure without something concrete", () => {
    // "unknown error" sent debugging in the wrong direction for an entire run.
    // Every failure path now carries the HTTP status at minimum.
    //
    // Comments are stripped: the code explains that history, and matching the
    // explanation would fail on the documentation rather than the behaviour.
    expect(withoutComments(journey)).not.toMatch(/unknown error/);
    expect(journey).toMatch(/HTTP \$\{status\}/);
  });
});

describe("the harness cannot touch a real instance", () => {
  it("runs under its own compose project", () => {
    expect(harness).toMatch(/PROJECT="sovrgnnet-e2e"/);
  });

  it("routes every compose call through one function", () => {
    // The point is that -p cannot be forgotten on the command that deletes
    // volumes. Any bare `docker compose` would sidestep that.
    const bare =
      harness.match(/^\s*(docker compose|docker-compose|\$DC) /gm) ?? [];
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

  it("passes the setup token through to the app container", () => {
    // Setting it in the env file isn't enough: compose uses that file for
    // interpolation, and the container only receives what its `environment:`
    // block lists. Missing it makes the instance refuse to create *any* first
    // account, which reads as the fail-closed behaviour working rather than as
    // a misconfiguration — and it cost a full e2e run to find.
    const compose = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
    expect(compose).toMatch(/SOVRGN_SETUP_TOKEN:\s*\$\{SOVRGN_SETUP_TOKEN\}/);
    expect(harness).toMatch(/SOVRGN_SETUP_TOKEN=/);
  });

  it("refuses to let the bootstrap checks pass on a missing token", () => {
    // The two "a stranger can't claim this" assertions would both pass against
    // an instance with no token configured, proving nothing. They check the
    // reason now.
    const journeyCode = withoutComments(journey);
    expect(journeyCode).toMatch(/notConfigured/);
    expect(journeyCode).toMatch(/proved nothing/);
  });

  it("generates its own secrets rather than reading a real .env", () => {
    expect(harness).toMatch(/mktemp/);
    expect(harness).toMatch(/DB_PASSWORD=\$\(secret\)/);
    // It must never fall back to the operator's environment file.
    expect(harness).not.toMatch(/--env-file \.env/);
  });
});

describe("the harness verifies what it claims to", () => {
  it("fails on a failed `compose up` instead of waiting for readiness", () => {
    // The output was piped to grep and suffixed with `|| true`, which discarded
    // the exit code twice. A build that died on ERR_PNPM_OUTDATED_LOCKFILE —
    // a stale lockfile, which is a one-command fix — produced no containers, no
    // visible error, three minutes of polling, and then "the stack never became
    // ready". Every word of that diagnosis was wrong.
    expect(harness).toMatch(/if ! compose up/);
    expect(withoutShellComments(harness)).not.toMatch(
      /compose up[^\n]*\|\s*grep/
    );
  });

  it("checks a container actually exists before polling it", () => {
    // Compose can exit zero and leave nothing running. Readiness would then be
    // measuring a port that was never going to open.
    expect(harness).toMatch(/compose ps -q app/);
  });

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
    for (const file of [
      "database.sql",
      "dendrite.sql",
      "ipfs_data.tar.gz",
      "env.backup",
    ]) {
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

/**
 * The cross-signing probe is the only thing in this repository that tests ADR
 * 0011's central assumption — that a homeserver records a completed UIA stage
 * against the session rather than against the request that carried it. If the
 * probe ever softens into a warning, or stops asserting, the harness goes
 * green while the design underneath it is broken, and nothing else in the
 * suite would notice. These guard the probe itself.
 */
describe("the journey proves the cross-signing auth path, not just runs it", () => {
  const code = withoutComments(journey);

  it("starts the flow unauthenticated and expects a challenge", () => {
    expect(code).toMatch(/device_signing\/upload/);
    expect(code).toMatch(/unauthenticated\.status !== 401/);
  });

  it("requires a password stage in the advertised flows", () => {
    // Completing some other stage would prove nothing about what the client's
    // re-submission actually needs satisfied.
    expect(code).toMatch(/m\.login\.password/);
  });

  it("has the instance complete the stage, rather than doing it here", () => {
    // The derived password must not appear in this process any more than it
    // appears in a browser — that is the whole point of the design.
    expect(code).toMatch(/matrix\.completeCrossSigningAuth/);
    expect(code).not.toMatch(/deriveMatrixPassword/);
  });

  it("re-submits carrying the session id and nothing else", () => {
    expect(code).toMatch(/auth:\s*\{\s*session:\s*challenge\.session\s*\}/);
  });

  it("throws on a 401 to the re-submission rather than warning", () => {
    // The failure that matters. A soft landing here would let the assumption
    // be false and the run still pass.
    expect(code).toMatch(/resubmitted\.status === 401/);
    expect(code).toMatch(/throw new JourneyError/);
  });

  it("reads the key back rather than trusting the 200", () => {
    // "Accepted" and "stored" are different claims.
    expect(code).toMatch(/keys\/query/);
    expect(code).toMatch(/master_keys/);
  });
});

/**
 * The crypto stage is the only thing anywhere that encrypts a real message.
 *
 * Everything else — unit tests, the journey, conformance — tests the judgement
 * around encryption without ever performing any. If this stage stops running
 * the shipped module, or stops asserting that the instance holds no plaintext,
 * the suite goes green over a product that might not encrypt at all.
 */
describe("the crypto stage exercises the shipped code, not a copy of it", () => {
  const crypto = readFileSync(join(ROOT, "scripts", "e2e-crypto.ts"), "utf8");
  const code = withoutComments(crypto);

  it("is wired into the harness", () => {
    expect(harness).toMatch(/e2e-crypto\.ts/);
    // A stage whose failure doesn't fail the run is decoration.
    expect(harness).toMatch(/e2e-crypto\.ts[\s\S]{0,80}\|\|\s*die/);
  });

  it("imports the module the browser runs", () => {
    // Not a reimplementation. A parallel copy could pass while the shipped
    // path is broken, which is the failure mode this whole stage exists for.
    expect(code).toMatch(/from "@\/lib\/matrixCrypto"/);
    expect(code).toMatch(/startCryptoSession/);
  });

  it("differs from the browser only in the crypto store", () => {
    expect(code).toMatch(/persistCryptoStore:\s*false/);
  });

  it("proves the instance holds no plaintext", () => {
    // The sharpest assertion available: if the index ever held the plaintext
    // of an encrypted message, every claim in the threat model is false.
    expect(code).toMatch(/row\.content === ""/);
    expect(code).toMatch(/includes\(secret\)/);
  });

  it("proves a second device decrypts, not just that sending worked", () => {
    expect(code).toMatch(/bob\.session\.lookup/);
    expect(code).toMatch(/decrypted!?\.body === secret/);
  });

  it("proves stored file bytes are ciphertext", () => {
    expect(code).toMatch(/storedBytes/);
    expect(code).toMatch(/attachment bytes/);
  });

  it("proves a tampered file is refused", () => {
    expect(code).toMatch(/tampered\[5\] \^= 0x01/);
    expect(code).toMatch(/refused/);
  });

  it("cannot hang the harness", () => {
    // The SDK retries a dead homeserver forever. A stage that stalls preflight
    // rather than failing it is a stage people stop running.
    expect(code).toMatch(/WATCHDOG_MS/);
    expect(code).toMatch(/process\.exit\(1\)/);
  });

  it("does not withhold room keys from unverified devices", () => {
    // The setting that looks like hardening and is actually an outage.
    //
    // `globalBlacklistUnverifiedDevices = true` withholds room keys from any
    // device its owner hasn't cross-signed. On a fresh instance that is every
    // device, so every encrypted message is unreadable by everyone — and
    // cross-signing doesn't fix it, because Alice only trusts Bob's device if
    // she has verified *Bob*, so every pair of members would have to compare
    // emoji first.
    //
    // It was set true here, written into the threat model as a mitigation, and
    // caught by the crypto stage the first time that ran. This test exists so
    // the next person to reach for it reads the reason instead of rediscovering
    // it against a real homeserver.
    const crypto = readFileSync(
      join(ROOT, "client", "src", "lib", "matrixCrypto.ts"),
      "utf8"
    );
    expect(withoutComments(crypto)).toMatch(
      /globalBlacklistUnverifiedDevices\s*=\s*false/
    );
    // The half that does survive: verification inherits across a person's
    // devices, so verifying is a per-person act rather than a per-device one.
    expect(withoutComments(crypto)).toMatch(
      /setTrustCrossSignedDevices\(true\)/
    );
  });

  it("drives both sides of a verification, and compares the emoji", () => {
    // "Interactive" describes the dialog, not the protocol. This was written
    // off as un-scriptable and it isn't.
    expect(code).toMatch(/requestOwnVerification/);
    expect(code).toMatch(/sasFor/);
    // Both prompts, and an assertion that they agree — checking only one side
    // would pass against two devices showing different emoji, which is the
    // one outcome the whole mechanism exists to detect.
    expect(code).toMatch(/promptA/);
    expect(code).toMatch(/promptB/);
  });

  it("waits out both halves of the verification handshake", () => {
    // Two separate silent failures, both found by running the check above and
    // neither reachable by a typecheck.
    //
    // A request sent to a device that has never heard of the sender is
    // *discarded* — the rust machine logs it and does nothing else, so the
    // asking device waits forever for a reply to a question nobody was asked.
    // Publishing this device first gives the other side something to look up.
    const crypto = withoutComments(
      readFileSync(
        join(ROOT, "client", "src", "lib", "matrixCrypto.ts"),
        "utf8"
      )
    );
    expect(crypto).toMatch(
      /getUserDeviceInfo\([\s\S]{0,80}\)[\s\S]{0,120}requestOwnUserVerification/
    );

    // And the initiator cannot start SAS until the reply names a device: the
    // SDK throws "other device is unknown" from `startVerification` otherwise.
    // A person clicking twice never notices; anything automatic hits it every
    // single time.
    expect(crypto).toMatch(
      /waitForReady\(request\)[\s\S]{0,200}startVerification/
    );
  });

  it("downloads this user's identity before recovery imports into it", () => {
    // Third of the same shape, and the worst-worded. Private cross-signing
    // keys import only against the matching public identity, which a
    // just-signed-in device may not have fetched — the rust store says "a
    // /keys/query needs to be done", the SDK reports
    // "importCrossSigningKeys failed to import the keys", and a person reads
    // that as "my recovery key is wrong".
    //
    // Being told the wrong thing here is worse than the failure. It sends
    // someone hunting for another copy of a key that was correct, at the one
    // moment they are already worried they've lost their history.
    const crypto = withoutComments(
      readFileSync(
        join(ROOT, "client", "src", "lib", "matrixCrypto.ts"),
        "utf8"
      )
    );
    expect(crypto).toMatch(
      /getUserDeviceInfo\([\s\S]{0,80}\)[\s\S]{0,200}bootstrapCrossSigning/
    );
  });

  it("proves a new device recovers history from the recovery key alone", () => {
    // ADR 0008 made recovery a precondition for flipping `e2ee`. Before this,
    // it had never run.
    expect(code).toMatch(/recoverWithKey/);
    expect(code).toMatch(/bootstrapEncryption/);
    // The negative first: a fresh device must *not* be able to read the
    // history before restoring, or the positive proves nothing.
    expect(code).toMatch(/before restoring anything/);
  });

  it("says what it does not prove", () => {
    // SAS and key backup need an interactive exchange this can't drive. Left
    // implied, they read as covered.
    expect(crypto).toMatch(/does not prove/);
  });
});

describe("the browser stage runs against the stack --keep leaves behind", () => {
  const browser = readFileSync(
    join(ROOT, "scripts", "e2e-browser.spec.ts"),
    "utf8"
  );

  it("signs in with an account rather than claiming the instance", () => {
    // The whole of the first run failed on this and it is worth being exact
    // about why, because the shape recurs: `--keep` is the *only* way to get a
    // stack a browser can reach, and a --keep stack has always already run the
    // journey. Its first account is claimed and its setup code is spent, so the
    // sign-up form it offers asks for an invite code. A spec holding a setup
    // token waits fifteen seconds for a field that will never render.
    //
    // Three of the four failures were just the first one's missing session
    // showing up later, which is the other half of the lesson: shared sign-in
    // state turns one real defect into four reports of it.
    const code = withoutComments(browser);
    expect(code).toMatch(/E2E_USERNAME/);
    expect(code).toMatch(/E2E_PASSWORD/);
    expect(code).not.toMatch(/SETUP_TOKEN/);
    expect(code).not.toMatch(/setup code/i);
  });

  it("has every test reach the dashboard on its own", () => {
    // Not tidiness. One of these tests asserts the access token is kept out of
    // web storage; a file that assumed the browser context would remember a
    // sign-in would be depending on the thing it is trying to disprove.
    const code = withoutComments(browser);
    const signIns = code.match(/ensureSignedIn\(page\)/g) ?? [];
    expect(signIns.length).toBe(4);
  });

  it("the harness prints credentials that exist, before deleting them", () => {
    // The journey's state file is the only place an account known to work is
    // written down, and the line that removes the work directory sits directly
    // below the block that reads it. Order is the whole correctness argument.
    const shell = withoutShellComments(harness);
    expect(shell).toMatch(/E2E_USERNAME=/);
    expect(shell).toMatch(/E2E_PASSWORD=/);
    expect(shell).toMatch(/journey-state\.json/);

    // The field the harness reads has to be one the journey actually writes.
    // This assertion is the reason the pair can be renamed safely: quoting
    // ownerEmail worked for as long as the journey gave its accounts an
    // address, and email became optional in #29 — so "it printed something"
    // was never the property worth checking.
    expect(shell).toMatch(/ownerUsername/);
    expect(withoutComments(journey)).toMatch(/ownerUsername,/);
    const readAt = shell.indexOf("journey-state.json");
    const deleteAt = shell.indexOf('rm -rf "$WORK_DIR"');
    expect(readAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(readAt);
  });
});
