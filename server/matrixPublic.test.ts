import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetForTests,
  __setFetchForTests,
  directSync,
  refreshDirectSync,
} from "./matrixPublic";

/**
 * The probe behind `clientMatrix`.
 *
 * The capability used to be `Boolean(MATRIX_PUBLIC_URL)`. These tests exist to
 * keep it from drifting back: a configured address is a claim, and a claim a
 * client acts on has to be checked.
 */

const fetchMock = vi.fn();
const OLD_URL = process.env.MATRIX_PUBLIC_URL;

function versions(list: string[] = ["v1.11"]): Response {
  return new Response(JSON.stringify({ versions: list }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  __setFetchForTests(fetchMock as unknown as typeof fetch);
  __resetForTests();
  delete process.env.MATRIX_PUBLIC_URL;
});

afterEach(() => {
  if (OLD_URL === undefined) delete process.env.MATRIX_PUBLIC_URL;
  else process.env.MATRIX_PUBLIC_URL = OLD_URL;
  vi.restoreAllMocks();
});

describe("with no public URL", () => {
  it("is unavailable and says why", () => {
    const status = directSync();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("no-public-url");
  });

  it("never touches the network", () => {
    directSync();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("with a public URL", () => {
  beforeEach(() => {
    process.env.MATRIX_PUBLIC_URL = "https://matrix.example.com";
  });

  it("is unavailable on the very first call, before any probe has finished", () => {
    // The important one. Setting the variable must not be enough.
    const status = directSync();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("unverified");
  });

  it("becomes available once a homeserver answers", async () => {
    fetchMock.mockResolvedValue(versions());
    const status = await refreshDirectSync();
    expect(status.available).toBe(true);
  });

  it("probes /_matrix/client/versions", async () => {
    fetchMock.mockResolvedValue(versions());
    await refreshDirectSync();
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://matrix.example.com/_matrix/client/versions"
    );
  });

  it("stays unavailable when the address answers but isn't a homeserver", async () => {
    // A reverse proxy's own 200 page. Passes a naive reachability check and
    // fails every real request afterwards.
    fetchMock.mockResolvedValue(new Response("<html>hello</html>", { status: 200 }));
    const status = await refreshDirectSync();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-a-homeserver");
  });

  it("stays unavailable when the versions list is empty", async () => {
    fetchMock.mockResolvedValue(versions([]));
    expect((await refreshDirectSync()).available).toBe(false);
  });

  it("stays unavailable on an error status", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));
    const status = await refreshDirectSync();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("unreachable");
  });

  it("stays unavailable when the request fails outright", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect((await refreshDirectSync()).available).toBe(false);
  });

  it("bounds the probe rather than hanging", async () => {
    // /api/instance is polled. A probe with no timeout makes the descriptor
    // endpoint wait on a third party, which is how /ready broke.
    fetchMock.mockImplementation(
      (_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );

    const started = Date.now();
    const status = await refreshDirectSync();
    expect(status.available).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  }, 10000);

  it("passes an abort signal so the request is really cancelled", async () => {
    fetchMock.mockResolvedValue(versions());
    await refreshDirectSync();
    const init = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("caching", () => {
  beforeEach(() => {
    process.env.MATRIX_PUBLIC_URL = "https://matrix.example.com";
  });

  it("serves the cached answer without re-probing", async () => {
    fetchMock.mockResolvedValue(versions());
    await refreshDirectSync();
    const after = fetchMock.mock.calls.length;

    directSync();
    directSync();
    directSync();

    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it("returns synchronously — it never awaits the network", () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    // If this blocked, /api/instance would block with it.
    const status = directSync();
    expect(status.available).toBe(false);
  });

  it("keeps reporting available while a later refresh is in flight", async () => {
    fetchMock.mockResolvedValue(versions());
    await refreshDirectSync();

    fetchMock.mockImplementation(() => new Promise(() => {}));
    // Stale-while-revalidate: a capability briefly out of date beats a
    // descriptor endpoint that waits.
    expect(directSync().available).toBe(true);
  });

  it("retries a negative answer much sooner than a positive one", async () => {
    // The common way to cache a "no" is probing during boot while the
    // homeserver is itself still starting. A 60-second "no" from that window
    // means the instance spends its first minute denying a capability it
    // has — the e2e journey caught exactly this shape.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow);

    try {
      fetchMock.mockRejectedValue(new Error("still starting"));
      await refreshDirectSync();
      expect(directSync().available).toBe(false);
      const probesAfterFailure = fetchMock.mock.calls.length;

      // Six seconds later: a negative is stale, and asking again re-probes.
      nowSpy.mockReturnValue(realNow + 6_000);
      fetchMock.mockResolvedValue(versions());
      directSync();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(probesAfterFailure);

      // A positive answer at the same age is still trusted — no re-probe.
      await refreshDirectSync();
      nowSpy.mockReturnValue(realNow + 12_000);
      const probesWhilePositive = fetchMock.mock.calls.length;
      directSync();
      expect(fetchMock.mock.calls.length).toBe(probesWhilePositive);
    } finally {
      nowSpy.mockRestore();
    }
  });
});

describe("a malformed URL", () => {
  it("is treated as absent rather than probed", () => {
    process.env.MATRIX_PUBLIC_URL = "matrix.example.com";
    const status = directSync();
    expect(status.available).toBe(false);
    expect(status.reason).toBe("no-public-url");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
