/**
 * The crypto machine, against a real homeserver — ADR 0008 stage 4, ADR 0011.
 *
 * Everything else that tests encryption in this repository tests the judgement
 * around it: what the instance may claim, what a reader is told when a message
 * won't open, whether the right state event gets written. None of it has ever
 * encrypted a message. Typechecking and unit tests cannot tell you whether the
 * crypto stack initialises, whether a room key reaches the other device, or
 * whether what comes back out is what went in — and those are the failures
 * that matter, because they are silent in exactly the way the rest is not.
 *
 * So this runs the shipped module. `client/src/lib/matrixCrypto.ts`, imported
 * directly, driven with two device-scoped sessions minted from the running
 * instance, against the Dendrite the harness started. The one concession to
 * Node is `persistCryptoStore: false`, because there is no IndexedDB here.
 * Every other line of the path under test is the one the browser runs.
 *
 * What it proves:
 *   - the Rust crypto stack starts and produces device keys
 *   - a message sent into an encrypted room leaves as `m.room.encrypted`
 *   - the instance's index records it content-blind, holding no plaintext
 *   - another user's device receives the room key and decrypts it
 *   - cross-signing, secret storage and key backup can be set up
 *   - two devices on one account complete an emoji verification
 *   - a device that never existed when a message was sent can read it
 *     afterwards, holding nothing but the recovery key
 *   - an attachment survives encrypt → upload → download → decrypt
 *   - tampering with stored bytes is refused rather than rendered
 *
 * SAS and key backup were previously described here as needing "an interactive
 * exchange a script can't drive". That was wrong: interactive describes the
 * dialog, not the protocol. Both sides of a verification are ordinary API
 * calls, and comparing the emoji is a string comparison — so they are driven
 * here rather than left to a browser.
 *
 * What it still does not prove is the **browser runtime**: this runs the same
 * module under Node, so the IndexedDB crypto store, the WASM as bundled by
 * Vite, and the panel wiring are all untouched. That needs a browser, and has
 * its own test.
 */

import {
  startCryptoSession,
  type CryptoSession,
  type VerificationRequest,
} from "@/lib/matrixCrypto";
import { decryptAttachment, encryptAttachment } from "@shared/attachments";

const BASE = process.env.E2E_BASE ?? "http://localhost:3999";
const HOMESERVER = process.env.E2E_MATRIX ?? "http://127.0.0.1:8008";
const STATE_FILE =
  process.env.E2E_WORK !== undefined
    ? `${process.env.E2E_WORK}/journey-state.json`
    : "";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

let checks = 0;
const ok = (message: string) => {
  checks += 1;
  console.log(`  ${GREEN}✓${RESET} ${message}`);
};
const detail = (message: string) => console.log(`    ${DIM}${message}${RESET}`);

class CryptoCheckError extends Error {}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CryptoCheckError(message);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new CryptoCheckError(
      `${message}\n      expected: ${String(expected)}\n      actual:   ${String(actual)}`
    );
  }
}

/** Poll until a predicate holds, because crypto is asynchronous everywhere. */
async function until<T>(
  what: string,
  attempt: () => T | Promise<T>,
  ready: (value: T) => boolean,
  { tries = 40, waitMs = 500 } = {}
): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < tries; i++) {
    last = await attempt();
    if (ready(last)) return last;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  throw new CryptoCheckError(
    `timed out waiting for ${what} (${tries * waitMs}ms). Last value: ${JSON.stringify(
      last
    )?.slice(0, 200)}`
  );
}

// --------------------------------------------------------------- transport

/** Just enough of a tRPC caller to sign in and mint a session. */
class Caller {
  private cookies = new Map<string, string>();

  /** Public, because the two REST file routes need it too. */
  cookieHeader(): string {
    return Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join("; ");
  }

  private absorb(response: Response): void {
    const raw =
      typeof (response.headers as { getSetCookie?: () => string[] })
        .getSetCookie === "function"
        ? (response.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [response.headers.get("set-cookie") ?? ""].filter(Boolean);
    for (const entry of raw) {
      const [pair] = entry.split(";");
      const index = pair.indexOf("=");
      if (index > 0)
        this.cookies.set(
          pair.slice(0, index).trim(),
          pair.slice(index + 1).trim()
        );
    }
  }

  async call<T>(path: string, input: unknown): Promise<T> {
    const response = await fetch(new URL(`/api/trpc/${path}`, BASE), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: this.cookieHeader(),
      },
      body: JSON.stringify({ json: input ?? {} }),
    });
    this.absorb(response);
    const text = await response.text();
    const body = JSON.parse(text) as {
      error?: { json?: { message?: string }; message?: string };
      result?: { data?: T | { json?: T } };
    };
    if (body.error) {
      throw new CryptoCheckError(
        `${path}: HTTP ${response.status} — ${body.error.json?.message ?? body.error.message}`
      );
    }
    const data = body.result?.data;
    return (
      data && typeof data === "object" && "json" in data
        ? (data as { json: T }).json
        : data
    ) as T;
  }

  async query<T>(path: string, input: unknown): Promise<T> {
    const url = new URL(`/api/trpc/${path}`, BASE);
    url.searchParams.set("input", JSON.stringify({ json: input }));
    const response = await fetch(url, {
      headers: { cookie: this.cookieHeader() },
    });
    this.absorb(response);
    const body = JSON.parse(await response.text()) as {
      result?: { data?: T | { json?: T } };
    };
    const data = body.result?.data;
    return (
      data && typeof data === "object" && "json" in data
        ? (data as { json: T }).json
        : data
    ) as T;
  }
}

interface Credentials {
  homeserverUrl: string;
  matrixUserId: string;
  accessToken: string;
  deviceId: string;
}

/**
 * Start a crypto session pointed at the harness's homeserver.
 *
 * The instance advertises its in-network address; from the host the same
 * homeserver is the published port. The harness knows the topology, so the
 * advertised URL is overridden rather than trusted.
 */
interface Device {
  session: CryptoSession;
  credentials: Credentials;
  /** Resolves with the first verification request another device sends here. */
  incomingVerification: Promise<VerificationRequest>;
}

async function session(caller: Caller, label: string): Promise<Device> {
  // No deviceId is passed, so the instance mints a fresh one. That is what
  // makes a second call a separate *device* on the same account rather than a
  // second session on the same device — which is the whole point for
  // self-verification and for restoring from backup.
  const credentials = await caller.call<Credentials>("matrix.clientSession", {
    displayName: `e2e crypto ${label}`,
  });

  let resolveIncoming: (request: VerificationRequest) => void = () => {};
  const incomingVerification = new Promise<VerificationRequest>(resolve => {
    resolveIncoming = resolve;
  });

  const started = await startCryptoSession({
    homeserverUrl: HOMESERVER,
    userId: credentials.matrixUserId,
    accessToken: credentials.accessToken,
    deviceId: credentials.deviceId,
    completeCrossSigningAuth: async uiaSession => {
      await caller.call("matrix.completeCrossSigningAuth", {
        session: uiaSession,
      });
    },
    onChange: () => {},
    onVerificationRequest: resolveIncoming,
    onTimelineEvent: () => {},
    // No IndexedDB in Node. The only line of this that differs from the browser.
    persistCryptoStore: false,
  });

  return { session: started, credentials, incomingVerification };
}

// ------------------------------------------------------------------- checks

/**
 * Turn the SDK's logging down to warnings.
 *
 * matrix-js-sdk logs every request, every key rotation and every one-time-key
 * count at debug level, and the Rust layer adds its own. On a passing run that
 * is a thousand lines burying eleven ticks, which makes the stage useless to
 * read and therefore useless to trust. Warnings and errors still come through,
 * which is what would matter on a failing run.
 *
 * `E2E_CRYPTO_VERBOSE=1` puts it all back for when something is actually
 * wrong — the log was genuinely how the withheld-keys failure got diagnosed.
 */
async function quietTheSdk(): Promise<void> {
  if (process.env.E2E_CRYPTO_VERBOSE === "1") return;

  const loglevel = (await import("loglevel")).default;
  // The SDK explicitly sets each of its loggers to DEBUG as it creates them,
  // so a default level won't do — every one that exists has to be turned down,
  // and any created later is caught by the default.
  loglevel.setDefaultLevel("warn");
  for (const named of Object.values(loglevel.getLoggers())) {
    named.setLevel("warn", false);
  }
  loglevel.setLevel("warn", false);
}

async function main(): Promise<void> {
  await quietTheSdk();
  console.log("\n  Crypto (real Olm/Megolm, real homeserver)");

  const state = STATE_FILE
    ? JSON.parse((await import("node:fs")).readFileSync(STATE_FILE, "utf8"))
    : null;
  assert(
    state?.ownerEmail,
    "no journey state — this runs after the user journey"
  );

  const capabilities = await (await fetch(`${BASE}/api/instance`)).json();
  if (capabilities?.capabilities?.e2ee !== true) {
    detail("instance doesn't advertise e2ee — nothing to exercise");
    console.log(`\n  ${DIM}skipped${RESET}`);
    return;
  }

  const owner = new Caller();
  await owner.call("auth.login", {
    email: state.ownerEmail,
    password: state.password,
  });
  const guest = new Caller();
  await guest.call("auth.login", {
    email: state.guestEmail,
    password: state.password,
  });

  const channel = await owner.query<{
    matrixRoomId: string;
    encrypted: boolean;
  }>("channels.getById", { channelId: state.channelId });
  assert(
    channel.encrypted,
    "the journey's channel isn't encrypted; nothing to test"
  );

  const alice = await session(owner, "alice");
  ok(
    `Crypto stack started (${alice.session.client.getCrypto()?.getVersion()})`
  );

  const bob = await session(guest, "bob");
  ok("Second device started, with its own keys");

  // Both clients must have synced the room before a key can be shared into it.
  const room = channel.matrixRoomId;
  await until(
    "both devices to see the room",
    () => [
      alice.session.client.getRoom(room),
      bob.session.client.getRoom(room),
    ],
    ([a, b]) => Boolean(a && b)
  );
  ok("Both devices joined and synced the encrypted room");

  // -- setting encryption up -------------------------------------------------
  //
  // Cross-signing, secret storage and a server-side key backup, through the
  // same call the encryption panel makes. ADR 0008 said `e2ee` doesn't flip
  // until recovery works; this is the first time any of it has run.
  const { recoveryKey } = await alice.session.bootstrapEncryption();
  assert(
    recoveryKey.replace(/\s/g, "").length >= 44,
    `that doesn't look like a recovery key: ${recoveryKey}`
  );
  ok("Cross-signing, secret storage and key backup set up");

  const ready = await until(
    "key backup to come on",
    () => alice.session.readiness(),
    state => state.keyBackupEnabled && state.crossSigningReady
  );
  assert(ready.deviceVerified, "the setting-up device should verify itself");
  ok("This device reports itself cross-signed, with backup running");

  const secret = `ciphertext round trip ${Date.now()}`;
  const eventId = await alice.session.send(room, secret);
  ok("Message sent through the shipped send path");

  // -- the instance holds ciphertext ----------------------------------------
  //
  // The sharpest assertion in this file. If the index ever held the plaintext
  // of an encrypted message, every claim in the threat model would be false
  // and nothing else here would notice.
  const indexed = await until(
    "the appservice to record the event",
    () =>
      owner.query<
        Array<{ content: string; encrypted: boolean; matrixEventId: string }>
      >("messages.listByChannel", { channelId: state.channelId }),
    rows => rows.some(m => m.matrixEventId === eventId)
  );
  const row = indexed.find(m => m.matrixEventId === eventId)!;
  assert(
    row.encrypted === true,
    "the index recorded an encrypted message as plaintext"
  );
  assert(
    row.content === "",
    `the index is holding message content it should never see: ${row.content}`
  );
  assert(
    !JSON.stringify(indexed).includes(secret),
    "the plaintext appears somewhere in what the instance returned"
  );
  ok(
    "The instance recorded it content-blind — no plaintext anywhere in the index"
  );

  // -- the other device can read it -----------------------------------------
  const decrypted = await until(
    "the second device to decrypt",
    () => bob.session.lookup(eventId),
    found => found?.verdict.state === "decrypted" && found.body.length > 0
  );
  assert(
    decrypted!.body === secret,
    `decrypted to the wrong thing: ${JSON.stringify(decrypted!.body)}`
  );
  ok("A second device received the room key and decrypted it");

  // -- emoji verification, driven from both ends -----------------------------
  //
  // "Interactive" describes the dialog, not the protocol. Both sides get the
  // same `SasPrompt` the UI renders, the emoji are compared here instead of by
  // a person, and both confirm. What this proves is the part the threat model
  // leans on: that a second device on the same account can actually be
  // verified, so the device list is a thing somebody can act on rather than
  // just read.
  const aliceSecond = await session(owner, "alice-second");
  ok("A second device for the same account started");

  // Wait for the first device to actually see the second one.
  //
  // Not padding. The rust machine ignores a verification request from a device
  // it has no keys for, and says so only in a log line — so firing the request
  // the instant the device exists produces a silent drop, which is what the
  // first run of this check found. A person hits the same window: they sign in
  // on a new device and the old one hasn't synced the device-list change yet.
  //
  // Waiting here models the human delay. `requestOwnVerification` also
  // publishes this device first, which narrows the window from the other side.
  await until(
    "the first device to see the second",
    () => alice.session.listDevices(),
    devices =>
      devices.some(d => d.deviceId === aliceSecond.credentials.deviceId)
  );
  ok("The first device can see the second in its device list");

  const outgoing = await aliceSecond.session.requestOwnVerification();
  const incoming = await Promise.race([
    alice.incomingVerification,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new CryptoCheckError("the first device never saw the request")
          ),
        20_000
      )
    ),
  ]);
  ok("The request reached the other device");

  // Both sides at once, which is the arrangement that used to glare: two
  // parties each calling startVerification produce two verifiers and a stall.
  const [promptA, promptB] = await Promise.all([
    alice.session.sasFor(incoming),
    aliceSecond.session.sasFor(outgoing),
  ]);

  assert(promptA.emoji.length > 0, "no emoji were produced");
  assertEqual(
    promptA.emoji.map(([glyph]) => glyph).join(" "),
    promptB.emoji.map(([glyph]) => glyph).join(" "),
    "the two devices are showing different emoji"
  );
  detail(promptA.emoji.map(([glyph, name]) => `${glyph} ${name}`).join("  "));
  ok(
    `Both devices show the same ${promptA.emoji.length} emoji, in the same order`
  );

  await Promise.all([promptA.confirm(), promptB.confirm()]);

  const verified = await until(
    "the second device to be marked verified",
    () => aliceSecond.session.listDevices(),
    devices => devices.some(d => d.isOwnDevice && d.verified)
  );
  assert(
    verified.find(d => d.isOwnDevice)?.verified,
    "the device verified itself with emoji and still reports unverified"
  );
  ok("The second device is now verified, on both sides of the exchange");

  // -- recovery on a device that didn't exist yet ----------------------------
  //
  // The "lost my laptop" path, and the one ADR 0008 made a precondition for
  // flipping `e2ee`. A brand-new device, no shared crypto store, holding
  // nothing but the recovery key — it should end up able to read a message
  // sent before it existed.
  // Wait for the key to actually be *in* the backup before asking for it.
  //
  // Uploading to key backup is a background loop, not part of sending. The
  // first run of this check restored "0 of 0 keys" and then sat for twenty
  // seconds waiting to decrypt; the PUT that put the key in the backup landed
  // afterwards. Nothing was broken — the harness was simply asking before
  // there was an answer.
  //
  // So this is a check in its own right, not a sleep: it asserts the room key
  // reaches the server-side backup at all, which is the thing recovery depends
  // on and which nothing else here proves. It also names the real limitation —
  // a device that signs in during that window recovers nothing, and the only
  // remedy is to try again once the sending device has caught up.
  // Generous, because the delay is deliberate and larger than it looks. The
  // SDK's backup loop sleeps a *random* 0–10s before each pass, to stop every
  // client in a room stampeding the server when a key rotates. And
  // `maybeUploadKey` is a no-op while a pass is already in flight, so a key
  // created just after one starts waits for the pass after that. Two jitters
  // plus round trips overruns 20s often enough to have done it on the first
  // run here.
  await until(
    "the room key to reach the server-side backup",
    () => alice.session.backedUpKeyCount(),
    count => count > 0,
    { tries: 90, waitMs: 1000 }
  );
  ok("The room key reached the server-side backup");

  const charlie = await session(owner, "charlie-recovered");
  const beforeRecovery = charlie.session.lookup(eventId);
  assert(
    beforeRecovery?.verdict.state !== "decrypted",
    "a fresh device could read the history before restoring anything"
  );
  ok("A fresh device can't read the earlier message, as expected");

  const restored = await charlie.session.recoverWithKey(recoveryKey);
  // Asserted rather than reported. "Restored 0 of 0" is a pass-shaped line for
  // a total failure, and left alone it turns into a twenty-second timeout on
  // the next step that says nothing about why.
  assert(
    restored.imported > 0,
    `the backup gave back nothing (${restored.imported} of ${restored.total}) — the key never reached it, or this device can't read it`
  );
  ok(`Restored ${restored.imported} of ${restored.total} keys from backup`);

  const recovered = await until(
    "the restored device to decrypt the earlier message",
    () => charlie.session.lookup(eventId),
    found => found?.verdict.state === "decrypted" && found.body.length > 0
  );
  assertEqual(
    recovered!.body,
    secret,
    "the restored device decrypted to the wrong thing"
  );
  ok("The recovery key alone recovered history the device never received");

  await charlie.session.stop();
  await aliceSecond.session.stop();

  // -- attachments -----------------------------------------------------------
  const payload = Buffer.from(`attachment bytes ${Date.now()}\n`.repeat(64));
  const sealed = await encryptAttachment(new Uint8Array(payload));
  assert(
    !Buffer.from(sealed.ciphertext).includes("attachment bytes"),
    "the ciphertext contains the plaintext"
  );

  const uploadUrl = new URL("/api/upload", BASE);
  uploadUrl.searchParams.set("channelId", String(state.channelId));
  uploadUrl.searchParams.set("filename", "sealed.txt");
  const uploaded = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      cookie: owner.cookieHeader(),
    },
    body: new Uint8Array(sealed.ciphertext),
  });
  assert(uploaded.ok, `upload failed: HTTP ${uploaded.status}`);
  const share = (await uploaded.json()) as { ipfsHash: string };
  ok(`Ciphertext uploaded and pinned (${share.ipfsHash.slice(0, 14)}…)`);

  await alice.session.sendFile(room, {
    filename: "sealed.txt",
    cid: share.ipfsHash,
    size: payload.length,
    mimeType: "text/plain",
    encryption: sealed.info,
  });

  // Bob learns the key only from the encrypted event — the instance never had
  // it to give him.
  const key = await until(
    "the file key to reach the second device",
    () => bob.session.attachmentFor(share.ipfsHash),
    found => Boolean(found)
  );
  ok("The file's key reached the second device inside the encrypted event");

  const stored = await fetch(new URL(`/api/files/${share.ipfsHash}`, BASE), {
    headers: { cookie: owner.cookieHeader() },
  });
  const storedBytes = new Uint8Array(await stored.arrayBuffer());
  assert(
    !Buffer.from(storedBytes).includes("attachment bytes"),
    "the instance is storing readable file bytes in an encrypted channel"
  );
  ok("What the instance stored is ciphertext, not the file");

  const opened = await decryptAttachment(storedBytes, key!);
  assert(
    Buffer.from(opened).equals(payload),
    "the file that came back isn't the file that went up"
  );
  ok("Downloaded and decrypted, byte-for-byte identical");

  const tampered = new Uint8Array(storedBytes);
  tampered[5] ^= 0x01;
  let refused = false;
  try {
    await decryptAttachment(tampered, key!);
  } catch {
    refused = true;
  }
  // AES-CTR is unauthenticated; without the hash check this returns altered
  // bytes and the UI renders them under a lock icon.
  assert(refused, "a tampered file decrypted instead of being refused");
  ok("A tampered file is refused rather than rendered");

  await Promise.all([alice.session.stop(), bob.session.stop()]);
  console.log(`\n  ${checks} checks passed`);
}

/**
 * A hard bound on the whole stage.
 *
 * The SDK's sync loop retries a dead homeserver forever, with backoff and
 * without complaint — correct for a client, fatal for a script. Every wait in
 * here is individually bounded, but a hang somewhere unbounded would stall
 * preflight rather than fail it, and a check that can hang is a check people
 * stop running. Two minutes is far beyond a passing run.
 */
/**
 * Raised from 120s once key backup joined the run.
 *
 * The backup upload loop jitters 0–10s per pass by design, and the recovery
 * check has to wait for a real one — so the floor for this stage moved by tens
 * of seconds through no fault of the code under test. The watchdog exists to
 * stop a hang from wedging CI forever, not to enforce a budget, so it should
 * sit well clear of the slowest honest run.
 */
const WATCHDOG_MS = 240_000;
const watchdog = setTimeout(() => {
  console.error(
    `\n  ${RED}✗ crypto checks exceeded ${WATCHDOG_MS / 1000}s and were stopped.` +
      ` Something is waiting on the homeserver.${RESET}\n`
  );
  process.exit(1);
}, WATCHDOG_MS);
// Don't let the timer itself be the reason the process stays alive.
watchdog.unref();

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n  ${RED}✗ ${message}${RESET}\n`);
    if (
      error instanceof Error &&
      error.stack &&
      !(error instanceof CryptoCheckError)
    ) {
      console.error(error.stack);
    }
    process.exit(1);
  });
