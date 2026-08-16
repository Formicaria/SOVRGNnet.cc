import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-matrix-tests";
  process.env.MATRIX_SHARED_SECRET = process.env.MATRIX_SHARED_SECRET || "test-shared-secret";
});

import { __setFetchForTests, isHomeserverReachable } from "./matrixService";

/**
 * The homeserver reachability probe must be bounded.
 *
 * It wasn't, and /ready calls it, so while Dendrite was starting the fetch hung
 * and the readiness endpoint hung with it — reporting nothing at all rather
 * than reporting a problem. Found by the end-to-end harness; invisible to every
 * test that mocked fetch to resolve immediately, which was all of them.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  __setFetchForTests(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isHomeserverReachable", () => {
  it("is true when the homeserver answers", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ versions: ["v1.11"] }), { status: 200 })
    );
    expect(await isHomeserverReachable()).toBe(true);
  });

  it("is false when the homeserver errors", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
    expect(await isHomeserverReachable()).toBe(false);
  });

  it("is false rather than hanging when the homeserver never responds", async () => {
    // A socket that accepts and then goes quiet — what a starting Dendrite
    // looks like, and what used to hang /ready indefinitely.
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );

    const started = Date.now();
    const reachable = await isHomeserverReachable(200);
    const elapsed = Date.now() - started;

    expect(reachable).toBe(false);
    expect(elapsed).toBeLessThan(2000);
  });

  it("passes an abort signal, so the request is actually cancelled", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await isHomeserverReachable();

    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    // Without this the timeout would fire and leave the request running.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not abort a healthy request early", async () => {
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise(resolve => {
          setTimeout(() => resolve(new Response("{}", { status: 200 })), 50);
          init?.signal?.addEventListener("abort", () => resolve(new Response("", { status: 599 })));
        })
    );

    expect(await isHomeserverReachable(3000)).toBe(true);
  });

  it("clears its timer, so a fast call leaves nothing pending", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));

    await isHomeserverReachable();

    // A probe called on every /ready that leaked a timer per call would keep
    // the event loop busy forever.
    expect(clearSpy).toHaveBeenCalled();
  });
});
