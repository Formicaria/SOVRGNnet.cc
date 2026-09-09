import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one-shot that encrypts channels from before ADR 0015.
 *
 * The properties worth pinning are the ones that make it safe to run on
 * every start of every instance forever: it does nothing until it can, it
 * does each channel once, one failure doesn't stop the rest, and it goes
 * quiet once there is nothing left.
 */
vi.mock("./db", () => ({
  listPlaintextChannels: vi.fn(),
  getMatrixCredentials: vi.fn(),
  markChannelEncrypted: vi.fn(),
}));
vi.mock("./instance", () => ({
  e2eeAvailable: vi.fn(),
}));
vi.mock("./matrixService", () => ({
  enableRoomEncryption: vi.fn(),
}));

import * as db from "./db";
import { e2eeAvailable } from "./instance";
import * as matrix from "./matrixService";
import { __resetSweepForTests, sweepPlaintextChannels } from "./encryptionSweep";

const A = { id: 1, matrixRoomId: "!a:test", serverId: 10, ownerId: 100 };
const B = { id: 2, matrixRoomId: "!b:test", serverId: 10, ownerId: 100 };
const OWNER = { userId: "@owner:test", accessToken: "owner-token" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  __resetSweepForTests();
  vi.mocked(e2eeAvailable).mockReturnValue(true);
  vi.mocked(db.listPlaintextChannels).mockResolvedValue([]);
  vi.mocked(db.getMatrixCredentials).mockResolvedValue(OWNER);
  vi.mocked(matrix.enableRoomEncryption).mockResolvedValue("$event");
  vi.mocked(db.markChannelEncrypted).mockResolvedValue(true);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("sweepPlaintextChannels", () => {
  it("does nothing until the instance can encrypt", async () => {
    vi.mocked(e2eeAvailable).mockReturnValue(false);
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A]);
    const result = await sweepPlaintextChannels();
    expect(result.skipped).toBe("e2ee-unavailable");
    expect(db.listPlaintextChannels).not.toHaveBeenCalled();
    expect(matrix.enableRoomEncryption).not.toHaveBeenCalled();
  });

  it("encrypts each plaintext channel as its community's owner and marks the index", async () => {
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A, B]);
    const result = await sweepPlaintextChannels();
    expect(result).toEqual({ encrypted: 2, failed: 0 });
    expect(matrix.enableRoomEncryption).toHaveBeenCalledWith("owner-token", "!a:test");
    expect(matrix.enableRoomEncryption).toHaveBeenCalledWith("owner-token", "!b:test");
    expect(db.markChannelEncrypted).toHaveBeenCalledWith("!a:test");
    expect(db.markChannelEncrypted).toHaveBeenCalledWith("!b:test");
  });

  it("one refusal doesn't stop the others, and is left for the next pass", async () => {
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A, B]);
    vi.mocked(matrix.enableRoomEncryption).mockImplementation(async (_t, room) => {
      if (room === "!a:test") throw new Error("M_FORBIDDEN");
      return "$event";
    });
    const result = await sweepPlaintextChannels();
    expect(result).toEqual({ encrypted: 1, failed: 1 });
    expect(db.markChannelEncrypted).toHaveBeenCalledTimes(1);
    expect(db.markChannelEncrypted).toHaveBeenCalledWith("!b:test");

    // Not finished: the failed one gets another go.
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A]);
    vi.mocked(matrix.enableRoomEncryption).mockResolvedValue("$event");
    const again = await sweepPlaintextChannels();
    expect(again).toEqual({ encrypted: 1, failed: 0 });
  });

  it("skips a community whose owner has no Matrix session yet, without failing the pass", async () => {
    // A room nobody has entered. There is no session to act as; the next
    // pass will find one once the owner opens the community.
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A]);
    vi.mocked(db.getMatrixCredentials).mockResolvedValue(null as never);
    const result = await sweepPlaintextChannels();
    expect(result).toEqual({ encrypted: 0, failed: 1 });
    expect(matrix.enableRoomEncryption).not.toHaveBeenCalled();
  });

  it("goes quiet once nothing is left", async () => {
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([]);
    expect(await sweepPlaintextChannels()).toEqual({ encrypted: 0, failed: 0 });
    // Finished: the database is not asked again.
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A]);
    const result = await sweepPlaintextChannels();
    expect(result.skipped).toBe("finished");
    expect(db.listPlaintextChannels).toHaveBeenCalledTimes(1);
  });

  it("finishes after a clean pass that encrypted everything", async () => {
    vi.mocked(db.listPlaintextChannels).mockResolvedValue([A]);
    await sweepPlaintextChannels();
    const result = await sweepPlaintextChannels();
    expect(result.skipped).toBe("finished");
  });
});
