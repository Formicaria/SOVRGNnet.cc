import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The ingest logic is what's under test, not drizzle — the db module is
 * mocked, matching how the route tests in health.test.ts isolate themselves.
 */
const getChannelByMatrixRoomId = vi.fn();
const getUserIdByMatrixId = vi.fn();
const ingestMessage = vi.fn();
const applyEditByEventId = vi.fn();
const deleteMessageByEventId = vi.fn();
const markChannelEncrypted = vi.fn();

vi.mock("./db", () => ({
  getChannelByMatrixRoomId: (...args: unknown[]) => getChannelByMatrixRoomId(...args),
  getUserIdByMatrixId: (...args: unknown[]) => getUserIdByMatrixId(...args),
  ingestMessage: (...args: unknown[]) => ingestMessage(...args),
  applyEditByEventId: (...args: unknown[]) => applyEditByEventId(...args),
  deleteMessageByEventId: (...args: unknown[]) => deleteMessageByEventId(...args),
  markChannelEncrypted: (...args: unknown[]) => markChannelEncrypted(...args),
}));

const HS_TOKEN = "test-hs-token";
const AS_TOKEN = "test-as-token";

let server: import("node:http").Server;
let base: string;

async function startWith(env: { hs?: string; as?: string }) {
  if (env.hs) process.env.MATRIX_APPSERVICE_HS_TOKEN = env.hs;
  else delete process.env.MATRIX_APPSERVICE_HS_TOKEN;
  if (env.as) process.env.MATRIX_APPSERVICE_AS_TOKEN = env.as;
  else delete process.env.MATRIX_APPSERVICE_AS_TOKEN;

  const { registerAppserviceRoutes } = await import("./appservice");
  const app = express();
  registerAppserviceRoutes(app);
  await new Promise<void>(resolve => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function txn(events: unknown[], token: string | null = HS_TOKEN) {
  return fetch(`${base}/_matrix/app/v1/transactions/txn_${Date.now()}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ events }),
  });
}

const message = (overrides: Record<string, unknown> = {}) => ({
  type: "m.room.message",
  event_id: `$ev_${Math.random().toString(36).slice(2)}`,
  sender: "@sovrgn_1:test",
  room_id: "!general:test",
  origin_server_ts: 1_700_000_000_000,
  content: { msgtype: "m.text", body: "hello from the client" },
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  getChannelByMatrixRoomId.mockResolvedValue({ id: 42, serverId: 7 });
  getUserIdByMatrixId.mockResolvedValue(9);
  ingestMessage.mockResolvedValue(true);
  applyEditByEventId.mockResolvedValue(true);
  deleteMessageByEventId.mockResolvedValue(true);
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.MATRIX_APPSERVICE_HS_TOKEN;
  delete process.env.MATRIX_APPSERVICE_AS_TOKEN;
});

describe("appservice transactions — authentication", () => {
  it("does not exist while unconfigured", async () => {
    await startWith({});
    const response = await txn([message()]);
    expect(response.status).toBe(404);
    expect(ingestMessage).not.toHaveBeenCalled();
  });

  it("rejects a wrong token and a missing one", async () => {
    await startWith({ hs: HS_TOKEN, as: AS_TOKEN });
    expect((await txn([message()], "wrong")).status).toBe(403);
    expect((await txn([message()], null)).status).toBe(403);
    expect(ingestMessage).not.toHaveBeenCalled();
  });

  it("accepts the legacy query-parameter form", async () => {
    await startWith({ hs: HS_TOKEN, as: AS_TOKEN });
    const response = await fetch(
      `${base}/transactions/txn_legacy?access_token=${HS_TOKEN}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [message()] }),
      }
    );
    expect(response.status).toBe(200);
    expect(ingestMessage).toHaveBeenCalledTimes(1);
  });
});

describe("appservice transactions — ingest", () => {
  beforeEach(async () => {
    await startWith({ hs: HS_TOKEN, as: AS_TOKEN });
  });

  it("records a text message with the homeserver's timestamp", async () => {
    const event = message();
    const response = await txn([event]);
    expect(response.status).toBe(200);
    expect(ingestMessage).toHaveBeenCalledWith(
      42,
      9,
      "hello from the client",
      event.event_id,
      false,
      1_700_000_000_000,
      "@sovrgn_1:test"
    );
  });

  it("skips rooms this instance doesn't know — federation doesn't change whose rooms these are", async () => {
    getChannelByMatrixRoomId.mockResolvedValue(undefined);
    expect((await txn([message()])).status).toBe(200);
    expect(ingestMessage).not.toHaveBeenCalled();
  });

  it("records a federated sender: known room, no local account (ADR 0010)", async () => {
    getUserIdByMatrixId.mockResolvedValue(null);
    const event = message({ sender: "@ana:their.server" });

    const response = await txn([event]);
    expect(response.status).toBe(200);
    // userId null, Matrix id carried — a silent hole in the conversation is
    // exactly what this exists to prevent.
    expect(ingestMessage).toHaveBeenCalledWith(
      42,
      null,
      "hello from the client",
      event.event_id,
      false,
      1_700_000_000_000,
      "@ana:their.server"
    );
  });

  it("applies redactions", async () => {
    const response = await txn([
      {
        type: "m.room.redaction",
        event_id: "$redaction",
        sender: "@sovrgn_1:test",
        room_id: "!general:test",
        redacts: "$target",
      },
    ]);
    expect(response.status).toBe(200);
    expect(deleteMessageByEventId).toHaveBeenCalledWith("$target");
  });

  it("applies m.replace edits to the original event", async () => {
    const response = await txn([
      message({
        content: {
          msgtype: "m.text",
          body: "* corrected",
          "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
          "m.new_content": { body: "corrected" },
        },
      }),
    ]);
    expect(response.status).toBe(200);
    expect(applyEditByEventId).toHaveBeenCalledWith("$original", "corrected");
    expect(ingestMessage).not.toHaveBeenCalled();
  });

  it("stores m.room.encrypted content-blind — stage 4's shape, tested now", async () => {
    const event = message({
      type: "m.room.encrypted",
      content: { algorithm: "m.megolm.v1.aes-sha2", ciphertext: "opaque" },
    });
    const response = await txn([event]);
    expect(response.status).toBe(200);
    expect(ingestMessage).toHaveBeenCalledWith(
      42,
      9,
      "",
      event.event_id,
      true,
      1_700_000_000_000,
      "@sovrgn_1:test"
    );
  });

  it("a failing event doesn't wedge the ones behind it", async () => {
    ingestMessage
      .mockRejectedValueOnce(new Error("db hiccup"))
      .mockResolvedValueOnce(true);

    const first = message();
    const second = message();
    const response = await txn([first, second]);

    // Wholesale acknowledgement — the homeserver must not retry forever.
    expect(response.status).toBe(200);
    expect(ingestMessage).toHaveBeenCalledTimes(2);
  });

  it("m.room.encryption marks the channel encrypted", async () => {
    markChannelEncrypted.mockResolvedValue(true);
    const response = await txn([
      {
        type: "m.room.encryption",
        event_id: "$enc_state",
        sender: "@sovrgn_1:test",
        room_id: "!general:test",
        content: { algorithm: "m.megolm.v1.aes-sha2" },
      },
    ]);
    expect(response.status).toBe(200);
    expect(markChannelEncrypted).toHaveBeenCalledWith("!general:test");
    expect(ingestMessage).not.toHaveBeenCalled();
  });

  it("file notices are not double-recorded as messages", async () => {
    const response = await txn([
      message({
        content: {
          msgtype: "m.file",
          body: "diagram.png",
          "cc.sovrgnnet.file": { cid: "bafy123", size: 1024 },
        },
      }),
    ]);
    expect(response.status).toBe(200);
    expect(ingestMessage).not.toHaveBeenCalled();
  });
});
