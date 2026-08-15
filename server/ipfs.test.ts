import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __setFetchForTests,
  addFile,
  catFile,
  IpfsError,
  isIpfsReachable,
} from "./ipfsService";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  __setFetchForTests(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  __setFetchForTests((...args) => fetch(...args));
});

describe("IPFS service", () => {
  it("adds a file and returns the CID", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ Name: "test.png", Hash: "bafytest123", Size: "42" }), {
        status: 200,
      })
    );

    const cid = await addFile(Buffer.from("hello"), "test.png");
    expect(cid).toBe("bafytest123");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/v0/add");
    expect(String(url)).toContain("pin=true");
    expect(init.method).toBe("POST");
  });

  it("uses the last line of a multi-line add response", async () => {
    const lines = [
      JSON.stringify({ Name: "a", Hash: "bafychild" }),
      JSON.stringify({ Name: "root", Hash: "bafyroot" }),
    ].join("\n");
    fetchMock.mockResolvedValueOnce(new Response(lines, { status: 200 }));

    expect(await addFile(Buffer.from("x"), "a")).toBe("bafyroot");
  });

  it("throws IpfsError on add failure", async () => {
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await expect(addFile(Buffer.from("x"), "a")).rejects.toThrowError(IpfsError);
  });

  it("cats a file back as a Buffer", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    );

    const buf = await catFile("bafytest123");
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([1, 2, 3]);
    expect(String(fetchMock.mock.calls[0][0])).toContain("cat?arg=bafytest123");
  });

  it("reports reachability without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await isIpfsReachable()).toBe(false);

    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    expect(await isIpfsReachable()).toBe(true);
  });
});
