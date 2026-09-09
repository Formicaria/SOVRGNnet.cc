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

describe("a channel is encrypted from its creation event (ADR 0015)", () => {
  it("puts m.room.encryption in the room's initial state — no second request", async () => {
    await makeInstanceCapable();

    const result = await createChannelRoom("token", "!space:test.local", "general");

    expect(result).toEqual({ roomId: ROOM, encrypted: true });
    const createCall = matrixFetch.mock.calls.find(([url]) =>
      String(url).includes("/createRoom")
    );
    expect(createCall, "no createRoom was made").toBeTruthy();
    const body = JSON.parse(createCall![1].body) as {
      initial_state: Array<{ type: string; content: { algorithm?: string } }>;
    };
    const encryption = body.initial_state.find(e => e.type === "m.room.encryption");
    expect(encryption, "createRoom carried no m.room.encryption").toBeTruthy();
    expect(encryption!.content.algorithm).toBe("m.megolm.v1.aes-sha2");

    // And nothing set it afterwards: "afterwards" was a window in which the
    // room existed and was plaintext, and the previous design lived in it.
    expect(
      matrixFetch.mock.calls.some(([url]) => String(url).includes("/state/m.room.encryption/"))
    ).toBe(false);
  });

  it("a homeserver that refuses leaves no room at all, not a plaintext one", async () => {
    await makeInstanceCapable();
    matrixFetch.mockImplementation(async (url: unknown) =>
      String(url).includes("/createRoom")
        ? jsonResponse(403, { errcode: "M_FORBIDDEN" })
        : jsonResponse(200, { room_id: ROOM })
    );

    await expect(createChannelRoom("token", "!space:test.local", "general")).rejects.toThrow();
    // No space child was linked: there is nothing to link.
    expect(
      matrixFetch.mock.calls.some(([url]) => String(url).includes("m.space.child"))
    ).toBe(false);
  });
});

describe("an instance that can't encrypt refuses to create a channel", () => {
  // Before ADR 0015 these two cases produced a plaintext room with an honest
  // `encrypted: false` — honest, and the state every stock deployment lived
  // in. The installer wires the proxy and the appservice on every path now,
  // so an instance that can't encrypt is one where something is broken, and
  // a broken thing gets said, not a room nobody meant.

  it("when the homeserver isn't answering", async () => {
    homeserverReachable(false);
    const { refreshDirectSync } = await import("./matrixPublic");
    await refreshDirectSync();

    await expect(
      createChannelRoom("token", "!space:test.local", "general")
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(matrixFetch).not.toHaveBeenCalled();
  });

  it("when the appservice isn't wired", async () => {
    // Reachable homeserver, no ingest. An encrypted message the instance
    // never records is invisible to every member; that is not a deployment
    // that may create rooms.
    process.env.MATRIX_PUBLIC_URL = "https://matrix.test.local";
    homeserverReachable(true);
    const { refreshDirectSync } = await import("./matrixPublic");
    await refreshDirectSync();

    await expect(
      createChannelRoom("token", "!space:test.local", "general")
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(matrixFetch).not.toHaveBeenCalled();
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
