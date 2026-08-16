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
 *   - a second device receives the room key and decrypts it
 *   - an attachment survives encrypt → upload → download → decrypt
 *   - tampering with stored bytes is refused rather than rendered
 *
 * What it does not prove: SAS verification and key backup, both of which need
 * two live sessions performing an interactive exchange, and neither of which
 * fits in a script that has to finish. Named here rather than implied.
 */

import { startCryptoSession, type CryptoSession } from "@/lib/matrixCrypto";
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
async function session(
  caller: Caller,
  label: string,
  onChange: () => void = () => {}
): Promise<{ session: CryptoSession; credentials: Credentials }> {
  const credentials = await caller.call<Credentials>("matrix.clientSession", {
    displayName: `e2e crypto ${label}`,
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
    onChange,
    onVerificationRequest: () => {},
    onTimelineEvent: () => {},
    // No IndexedDB in Node. The only line of this that differs from the browser.
    persistCryptoStore: false,
  });

  return { session: started, credentials };
}

// ------------------------------------------------------------------- checks

async function main(): Promise<void> {
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
const WATCHDOG_MS = 120_000;
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
