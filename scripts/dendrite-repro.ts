/**
 * Dendrite to-device loss reproduction — no SOVRGN app in the loop.
 *
 * The e2e bisection (PR #34) isolated the crypto-stage failure to a single
 * trigger: running `servers.create` a second time. That operation is four
 * plain CS-API requests — createRoom (space), createRoom (channel, restricted
 * to the space), PUT m.space.child, PUT m.room.encryption — after which
 * Dendrite v0.15.2 accepts every subsequent /sendToDevice with a 200 and
 * delivers none of them, stores none of them (syncapi_send_to_device stays
 * empty), instance-wide, while room events keep flowing. The plain-ping probe
 * proved the loss is not crypto-related, which is why this script needs no
 * SDK: it is nothing but fetch.
 *
 * What it does, against a bare homeserver:
 *   1. Register three users via shared-secret registration: a builder (who
 *      creates rooms and is never messaged), a sender, and a receiver. The
 *      sender and receiver never join any room — to-device is room-less by
 *      design, so the probe is pure.
 *   2. Probe: sender PUTs an unencrypted to-device ping at the receiver's
 *      device; receiver does a fresh initial /sync and we look for that
 *      exact ping by label.
 *   3. Builder performs one "server create" round (the faithful four
 *      requests above). Probe again. Repeat for REPRO_ROUNDS rounds.
 *
 * Reading the verdicts:
 *   - Baseline probe lost           → to-device is broken before any rooms
 *                                     exist; different bug than the bisected
 *                                     one.
 *   - All probes delivered          → NOT reproduced bare; the harness delta
 *                                     (journey traffic volume, appservice
 *                                     interplay) is part of the trigger.
 *   - Probe N first lost            → reproduced; N create-rounds arm it.
 *
 * Env: REPRO_HS (homeserver base URL), REPRO_SECRET (registration shared
 * secret), REPRO_ROUNDS (default 2), REPRO_SKIP (comma list to thin a round:
 * "encryption", "child", "restricted", "space-type" — for minimization runs
 * after a red one).
 *
 * SENTINEL MODES (REPRO_MODE=plant|harvest, REPRO_STATE=<json path>).
 * The bare run above came back fully green — twice, with and without the
 * appservice — so the four requests alone are the spark, not the fuel; the
 * trigger needs the journey's accumulated state underneath it. These modes
 * split the next question: when the harness arms the loss, is to-device
 * dead for EVERYONE (global pipeline death — upstream's problem, homeserver
 * swap justified) or only for the journey's own users (per-user state
 * corruption — our traffic pattern is implicated)?
 *   plant   — before the walk: register three bystander users who will
 *             never touch a room, take a baseline probe, save credentials.
 *   harvest — after the arming stage: probe the same bystanders. Delivered
 *             while the crypto stage still fails = per-user. Lost = global.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { createHmac } from "node:crypto";

const HS = (process.env.REPRO_HS ?? "").replace(/\/+$/, "");
const SECRET = process.env.REPRO_SECRET ?? "";
const ROUNDS = Number(process.env.REPRO_ROUNDS ?? "2");
const SKIP = new Set(
  (process.env.REPRO_SKIP ?? "").split(",").map(s => s.trim()).filter(Boolean)
);

if (!HS || !SECRET) {
  console.error("REPRO_HS and REPRO_SECRET are required.");
  process.exit(2);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<T> {
  const res = await fetch(`${HS}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

interface Account {
  userId: string;
  accessToken: string;
  deviceId: string;
}

async function register(localpart: string): Promise<Account> {
  const { nonce } = await req<{ nonce: string }>(
    "GET",
    "/_synapse/admin/v1/register"
  );
  const password = `repro-${nonce.slice(0, 8)}`;
  const mac = createHmac("sha1", SECRET)
    .update(`${nonce}\x00${localpart}\x00${password}\x00notadmin`)
    .digest("hex");
  const reg = await req<{
    user_id: string;
    access_token: string;
    device_id?: string;
  }>("POST", "/_synapse/admin/v1/register", {
    nonce,
    username: localpart,
    password,
    admin: false,
    mac,
  });
  return {
    userId: reg.user_id,
    accessToken: reg.access_token,
    deviceId: reg.device_id ?? "*",
  };
}

/** The four requests of servers.create, bodies faithful to matrixService.ts. */
async function createRound(builder: Account, n: number): Promise<void> {
  const serverName = builder.userId.split(":").slice(1).join(":");
  const space = await req<{ room_id: string }>(
    "POST",
    "/_matrix/client/v3/createRoom",
    {
      name: `repro space ${n}`,
      preset: "private_chat",
      visibility: "private",
      room_version: "10",
      power_level_content_override: { invite: 50 },
      ...(SKIP.has("space-type")
        ? {}
        : { creation_content: { type: "m.space" } }),
    },
    builder.accessToken
  );
  const channel = await req<{ room_id: string }>(
    "POST",
    "/_matrix/client/v3/createRoom",
    {
      name: "general",
      preset: "private_chat",
      visibility: "private",
      room_version: "10",
      power_level_content_override: { invite: 50 },
      ...(SKIP.has("restricted")
        ? {}
        : {
            initial_state: [
              {
                type: "m.room.join_rules",
                state_key: "",
                content: {
                  join_rule: "restricted",
                  allow: [
                    { type: "m.room_membership", room_id: space.room_id },
                  ],
                },
              },
            ],
          }),
    },
    builder.accessToken
  );
  if (!SKIP.has("child")) {
    await req(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(space.room_id)}/state/m.space.child/${encodeURIComponent(channel.room_id)}`,
      { via: [serverName], suggested: true },
      builder.accessToken
    );
  }
  if (!SKIP.has("encryption")) {
    await req(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(channel.room_id)}/state/m.room.encryption/`,
      {
        algorithm: "m.megolm.v1.aes-sha2",
        rotation_period_ms: 24 * 60 * 60 * 1000,
        rotation_period_msgs: 100,
      },
      builder.accessToken
    );
  }
  console.log(
    `  round ${n}: space=${space.room_id} channel=${channel.room_id}` +
      (SKIP.size ? ` (skipped: ${[...SKIP].join(",")})` : "")
  );
}

interface SyncToDevice {
  next_batch: string;
  to_device?: { events?: Array<{ type: string; content?: { label?: string } }> };
}

let txn = 0;

/** Send a labelled plain ping, fresh-initial-sync as receiver, look for it. */
async function probe(
  label: string,
  sender: Account,
  receiver: Account
): Promise<boolean> {
  await req(
    "PUT",
    `/_matrix/client/v3/sendToDevice/m.sovrgnnet.ping/repro-${Date.now()}-${txn++}`,
    {
      messages: {
        [receiver.userId]: { [receiver.deviceId]: { ping: true, label } },
      },
    },
    sender.accessToken
  );
  await sleep(2000);
  const sync = await req<SyncToDevice>(
    "GET",
    "/_matrix/client/v3/sync?timeout=0",
    undefined,
    receiver.accessToken
  );
  const events = sync.to_device?.events ?? [];
  const hit = events.some(e => e.content?.label === label);
  // Acknowledge what was delivered so earlier probes' events don't linger
  // into the next probe's initial sync (deletion happens on a later since).
  await req(
    "GET",
    `/_matrix/client/v3/sync?timeout=0&since=${encodeURIComponent(sync.next_batch)}`,
    undefined,
    receiver.accessToken
  );
  console.log(
    `  probe ${label}: ${hit ? "DELIVERED" : "LOST"} ` +
      `(${events.length} to-device event(s) in a fresh initial sync)`
  );
  return hit;
}

const MODE = process.env.REPRO_MODE ?? "full";
const STATE = process.env.REPRO_STATE ?? "";

interface SentinelState {
  sender: Account;
  receiver: Account;
}

/** Register bystanders, prove baseline delivery, save them for later. */
async function plant(): Promise<void> {
  if (!STATE) throw new Error("REPRO_MODE=plant needs REPRO_STATE.");
  const stamp = Date.now().toString(36);
  const sender = await register(`sentinel-sender-${stamp}`);
  const receiver = await register(`sentinel-receiver-${stamp}`);
  console.log(`  sentinels: ${sender.userId} -> ${receiver.userId}`);
  const ok = await probe("sentinel-baseline", sender, receiver);
  writeFileSync(STATE, JSON.stringify({ sender, receiver } satisfies SentinelState));
  if (!ok) {
    console.log(
      "Baseline lost before the walk even started — the stack is broken " +
        "independently of anything the walk does."
    );
    process.exit(1);
  }
  process.exit(0);
}

/** Probe the planted bystanders after the walk has armed the loss. */
async function harvest(): Promise<void> {
  if (!STATE) throw new Error("REPRO_MODE=harvest needs REPRO_STATE.");
  const { sender, receiver } = JSON.parse(readFileSync(STATE, "utf8")) as SentinelState;
  const ok = await probe("sentinel-post-arming", sender, receiver);
  console.log(
    ok
      ? "Sentinels still receive to-device — the loss is PER-USER: the " +
          "journey's own accounts carry corrupted state, the pipeline " +
          "itself is alive."
      : "Sentinels lost too — the loss is GLOBAL: the pipeline is dead " +
          "for users who never touched a room."
  );
  process.exit(ok ? 0 : 1);
}

async function main(): Promise<void> {
  console.log(`Dendrite to-device repro against ${HS} (mode: ${MODE})`);
  if (MODE === "plant") return plant();
  if (MODE === "harvest") return harvest();
  console.log(`  rounds=${ROUNDS} skip=[${[...SKIP].join(",") || "none"}]`);

  const stamp = Date.now().toString(36);
  const builder = await register(`repro-builder-${stamp}`);
  const sender = await register(`repro-sender-${stamp}`);
  const receiver = await register(`repro-receiver-${stamp}`);
  console.log(
    `  users: ${builder.userId} (builds), ${sender.userId} -> ${receiver.userId} (device ${receiver.deviceId})`
  );

  const verdicts: Array<{ label: string; delivered: boolean }> = [];
  const run = async (label: string) =>
    verdicts.push({ label, delivered: await probe(label, sender, receiver) });

  await run("p0-baseline");
  for (let n = 1; n <= ROUNDS; n++) {
    await createRound(builder, n);
    await run(`p${n}-after-round-${n}`);
  }

  console.log("\nVerdicts:");
  for (const v of verdicts) {
    console.log(`  ${v.delivered ? "✓" : "✗"} ${v.label}`);
  }

  const firstLoss = verdicts.find(v => !v.delivered);
  if (!firstLoss) {
    console.log(
      "\nAll probes delivered — NOT reproduced bare. The harness delta " +
        "(journey traffic volume, or the appservice interplay) is part of " +
        "the trigger. Next: raise REPRO_ROUNDS, then vary the appservice."
    );
    process.exit(0);
  }
  if (firstLoss.label === "p0-baseline") {
    console.log(
      "\nBaseline probe lost — to-device is broken before any rooms exist. " +
        "That is a different failure than the bisected one; suspect the " +
        "stack, not the create sequence."
    );
  } else {
    console.log(
      `\nReproduced: to-device delivery died at ${firstLoss.label}. ` +
        "This transcript plus the Dendrite log is the upstream issue."
    );
  }
  process.exit(1);
}

main().catch(err => {
  console.error(`Repro script failed to run: ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
