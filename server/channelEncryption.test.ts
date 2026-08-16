import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET =
    process.env.JWT_SECRET || "test-secret-for-channel-tests";
  process.env.MATRIX_SHARED_SECRET =
    process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createChannelRoom } from "./matrixBridge";
import {
  __resetForTests,
  __setFetchForTests as setProbeFetch,
} from "./matrixPublic";
import { __setFetchForTests as setMatrixFetch } from "./matrixService";

/**
 * Encryption is the default, and the default has to be conditional.
 *
 * Two things can go wrong here and only one of them is loud. Creating a
 * plaintext channel on an instance that could have encrypted it is a missed
 * default — bad, and visible. Marking a channel encrypted when the state event
 * never landed is a lock icon over plaintext, which is the failure this
 * codebase has now made twice in other forms and must not make again.
 */

const ROOM = "!created:test.local";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const matrixFetch = vi.fn();

/** Make the reachability probe answer like a real homeserver, or not at all. */
function homeserverReachable(reachable: boolean): void {
  __resetForTests();
  setProbeFetch((async () =>
    reachable
      ? jsonResponse(200, { versions: ["v1.11"] })
      : new Response("", { status: 502 })) as unknown as typeof fetch);
}

beforeEach(() => {
  matrixFetch.mockReset();
  setMatrixFetch(matrixFetch as unknown as typeof fetch);
  // A factory, not a fixed value: a Response body can only be read once, and
  // `mockResolvedValue` would hand the same exhausted object to every call.
  matrixFetch.mockImplementation(async () =>
    jsonResponse(200, { room_id: ROOM })
  );
});

afterEach(() => {
  setMatrixFetch((...args) => fetch(...args));
  setProbeFetch((...args) => fetch(...args));
  __resetForTests();
  delete process.env.MATRIX_PUBLIC_URL;
  delete process.env.MATRIX_APPSERVICE_HS_TOKEN;
  delete process.env.MATRIX_APPSERVICE_AS_TOKEN;
});

/** Everything `e2eeAvailable()` needs, so the capable branch actually runs. */
async function makeInstanceCapable(): Promise<void> {
  process.env.MATRIX_PUBLIC_URL = "https://matrix.test.local";
  process.env.MATRIX_APPSERVICE_HS_TOKEN = "hs";
  process.env.MATRIX_APPSERVICE_AS_TOKEN = "as";
  homeserverReachable(true);
  // The probe caches; prime it so the first call under test isn't racing it.
  const { refreshDirectSync } = await import("./matrixPublic");
  await refreshDirectSync();
}

describe("a capable instance encrypts every channel it creates", () => {
  it("sets m.room.encryption without being asked", async () => {
    await makeInstanceCapable();

    const result = await createChannelRoom(
      "token",
      "!space:test.local",
      "general"
    );

    expect(result).toEqual({ roomId: ROOM, encrypted: true });
    const stateCall = matrixFetch.mock.calls.find(([url]) =>
      String(url).includes("/state/m.room.encryption/")
    );
    expect(stateCall, "no m.room.encryption was written").toBeTruthy();
    expect(JSON.parse(stateCall![1].body).algorithm).toBe(
      "m.megolm.v1.aes-sha2"
    );
  });

  it("creates the room before encrypting it", async () => {
    // Room creation makes more than one request (the space child among them),
    // so this asserts the relative order rather than fixed indices — a
    // homeserver that refuses the state event must leave a working plaintext
    // channel, not a half-made room.
    await makeInstanceCapable();
    await createChannelRoom("token", "!space:test.local", "general");

    const urls = matrixFetch.mock.calls.map(([url]) => String(url));
    const created = urls.findIndex(u => u.includes("/createRoom"));
    const encrypted = urls.findIndex(u => u.includes("m.room.encryption"));
    expect(created).toBeGreaterThan(-1);
    expect(encrypted).toBeGreaterThan(created);
  });

  it("reports unencrypted when the state event is refused", async () => {
    await makeInstanceCapable();
    // Refuse only the encryption call, by URL — sequencing by call index would
    // land the 403 on whichever intermediate request happened to be second.
    matrixFetch.mockImplementation(async (url: unknown) =>
      String(url).includes("m.room.encryption")
        ? jsonResponse(403, { errcode: "M_FORBIDDEN" })
        : jsonResponse(200, { room_id: ROOM })
    );

    const result = await createChannelRoom(
      "token",
      "!space:test.local",
      "general"
    );

    // The channel exists and is usable; it is simply not encrypted, and says
    // so. Returning `encrypted: true` here would put a lock icon over
    // plaintext — the one direction this flag must never be wrong in.
    expect(result).toEqual({ roomId: ROOM, encrypted: false });
  });
});

describe("an instance that can't offer encryption doesn't pretend", () => {
  it("creates a plaintext channel when no homeserver is advertised", async () => {
    __resetForTests();
    const result = await createChannelRoom(
      "token",
      "!space:test.local",
      "general"
    );

    expect(result).toEqual({ roomId: ROOM, encrypted: false });
    expect(
      matrixFetch.mock.calls.some(([url]) =>
        String(url).includes("m.room.encryption")
      ),
      "tried to encrypt on an instance that can't support it"
    ).toBe(false);
  });

  it("creates a plaintext channel when the appservice isn't wired", async () => {
    // Reachable homeserver, no ingest. An encrypted message the instance never
    // records is invisible to members on the API fallback, so this is not a
    // deployment that may encrypt.
    process.env.MATRIX_PUBLIC_URL = "https://matrix.test.local";
    homeserverReachable(true);
    const { refreshDirectSync } = await import("./matrixPublic");
    await refreshDirectSync();

    const result = await createChannelRoom(
      "token",
      "!space:test.local",
      "general"
    );
    expect(result.encrypted).toBe(false);
  });
});

/**
 * The refusals in `messages.send` and `messages.edit` have to run *after* the
 * membership check.
 *
 * This was wrong when encryption became the default, and the way it was wrong
 * is instructive: a non-member got "this channel is encrypted" instead of "you
 * are not a member", which both leaks the existence and state of a channel to
 * a stranger and makes every test asserting "non-members can't post" pass on
 * the encryption branch without membership ever being consulted.
 *
 * Checked by reading the source, because the alternative is standing up a
 * database to prove the order of two lines.
 */
describe("membership is checked before encryption", () => {
  const routers = readFileSync(join(__dirname, "routers.ts"), "utf8");

  function bodyOf(procedure: string): string {
    const start = routers.indexOf(`    ${procedure}: protectedProcedure`);
    expect(start, `${procedure} not found in routers.ts`).toBeGreaterThan(-1);
    // Far enough to cover the guards at the top of the handler.
    return routers.slice(start, start + 2400);
  }

  it.each(["send", "edit"])("%s consults membership first", procedure => {
    const body = bodyOf(procedure);
    const membership = body.indexOf("requireServerMembership");
    const encryption = body.indexOf("channel.encrypted");
    expect(membership, "no membership check").toBeGreaterThan(-1);
    expect(encryption, "no encryption check").toBeGreaterThan(-1);
    expect(
      membership,
      `${procedure} tells a non-member the channel is encrypted`
    ).toBeLessThan(encryption);
  });
});
