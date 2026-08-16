import { describe, expect, it } from "vitest";
import {
  clientDelegation,
  directSyncStatus,
  parsePublicMatrixUrl,
  serverDelegation,
} from "@shared/matrixDelegation";

describe("parsePublicMatrixUrl", () => {
  it("accepts a plain https origin", () => {
    expect(parsePublicMatrixUrl("https://matrix.example.com")).toBe("https://matrix.example.com");
  });

  it("strips a trailing slash", () => {
    // Every caller appends /_matrix/..., and `//` isn't treated identically by
    // every homeserver implementation.
    expect(parsePublicMatrixUrl("https://matrix.example.com/")).toBe("https://matrix.example.com");
  });

  it("keeps an explicit port", () => {
    expect(parsePublicMatrixUrl("https://example.com:8448")).toBe("https://example.com:8448");
  });

  it("allows http, for a LAN deployment", () => {
    expect(parsePublicMatrixUrl("http://192.168.1.10:8008")).toBe("http://192.168.1.10:8008");
  });

  it.each([
    ["", "empty"],
    ["   ", "whitespace"],
    ["matrix.example.com", "no scheme"],
    ["ftp://matrix.example.com", "wrong scheme"],
    ["https://", "no host"],
    ["not a url at all", "nonsense"],
  ])("rejects %s (%s)", input => {
    expect(parsePublicMatrixUrl(input)).toBeNull();
  });

  it("rejects a URL with a path", () => {
    // Legal, but almost never intended — it would put every Matrix call under
    // that path and fail in a way that looks like a homeserver bug.
    expect(parsePublicMatrixUrl("https://example.com/matrix")).toBeNull();
  });

  it("rejects query strings and fragments", () => {
    expect(parsePublicMatrixUrl("https://example.com?x=1")).toBeNull();
    expect(parsePublicMatrixUrl("https://example.com#x")).toBeNull();
  });

  it("treats null and undefined as absent", () => {
    expect(parsePublicMatrixUrl(null)).toBeNull();
    expect(parsePublicMatrixUrl(undefined)).toBeNull();
  });
});

describe("clientDelegation", () => {
  it("points clients at the homeserver", () => {
    expect(clientDelegation("https://matrix.example.com")).toEqual({
      "m.homeserver": { base_url: "https://matrix.example.com" },
    });
  });

  it("is null when nothing is configured", () => {
    // 404 beats a delegation pointing nowhere: a client that gets a 404 falls
    // back sensibly, one given a broken address fails later and less clearly.
    expect(clientDelegation(null)).toBeNull();
    expect(clientDelegation("")).toBeNull();
  });

  it("is null when the configured URL is malformed", () => {
    expect(clientDelegation("matrix.example.com")).toBeNull();
  });

  it("omits m.identity_server unless one is given", () => {
    const document = clientDelegation("https://matrix.example.com");
    expect(document && "m.identity_server" in document).toBe(false);
  });
});

describe("serverDelegation", () => {
  it("is null when federation is off, even with a URL", () => {
    // Advertising a federation endpoint while refusing federated traffic
    // invites other servers to try and then fail.
    expect(serverDelegation("https://matrix.example.com", false)).toBeNull();
  });

  it("names host and port when federation is on", () => {
    expect(serverDelegation("https://matrix.example.com", true)).toEqual({
      "m.server": "matrix.example.com:443",
    });
  });

  it("keeps an explicit port rather than overriding it", () => {
    expect(serverDelegation("https://matrix.example.com:8448", true)).toEqual({
      "m.server": "matrix.example.com:8448",
    });
  });

  it("uses 8008 for http", () => {
    expect(serverDelegation("http://matrix.example.com", true)).toEqual({
      "m.server": "matrix.example.com:8008",
    });
  });

  it("is a host:port, never a URL", () => {
    // The federation API has its own scheme rules; a document containing
    // https:// is rejected by other servers.
    const document = serverDelegation("https://matrix.example.com", true);
    expect(document?.["m.server"]).not.toContain("://");
  });

  it("is null with no URL, federation on or not", () => {
    expect(serverDelegation(null, true)).toBeNull();
    expect(serverDelegation(null, false)).toBeNull();
  });
});

describe("directSyncStatus", () => {
  const verified = { reachable: true, isHomeserver: true, checked: true };

  it("is available only after a successful probe", () => {
    expect(directSyncStatus("https://matrix.example.com", verified).available).toBe(true);
  });

  it("is NOT available merely because a URL is configured", () => {
    // The whole point. `Boolean(MATRIX_PUBLIC_URL)` announced the capability
    // before anything confirmed a homeserver was there — the same mistake the
    // encryption flag made in v0.3.
    const status = directSyncStatus("https://matrix.example.com", null);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("unverified");
  });

  it("is not available when the probe hasn't run", () => {
    const status = directSyncStatus("https://matrix.example.com", {
      reachable: false,
      isHomeserver: false,
      checked: false,
    });
    expect(status.available).toBe(false);
    expect(status.reason).toBe("unverified");
  });

  it("reports unreachable when nothing answered", () => {
    const status = directSyncStatus("https://matrix.example.com", {
      reachable: false,
      isHomeserver: false,
      checked: true,
    });
    expect(status.available).toBe(false);
    expect(status.reason).toBe("unreachable");
    expect(status.detail).toContain("keep using the proxy");
  });

  it("reports not-a-homeserver when something else answered", () => {
    // A reverse proxy returning its own 200 page would pass a naive check and
    // fail every real request afterwards.
    const status = directSyncStatus("https://matrix.example.com", {
      reachable: true,
      isHomeserver: false,
      checked: true,
    });
    expect(status.available).toBe(false);
    expect(status.reason).toBe("not-a-homeserver");
  });

  it("explains the proxy when no URL is set", () => {
    const status = directSyncStatus(null, null);
    expect(status.available).toBe(false);
    expect(status.reason).toBe("no-public-url");
    expect(status.detail).toContain("MATRIX_PUBLIC_URL");
  });

  it("is unavailable for a malformed URL even with a passing probe", () => {
    expect(directSyncStatus("not-a-url", verified).available).toBe(false);
  });

  it("gives a reason whenever it is unavailable", () => {
    // Degrading gracefully means explaining, not hiding.
    for (const status of [
      directSyncStatus(null, null),
      directSyncStatus("https://m.example.com", null),
      directSyncStatus("https://m.example.com", { reachable: false, isHomeserver: false, checked: true }),
      directSyncStatus("https://m.example.com", { reachable: true, isHomeserver: false, checked: true }),
    ]) {
      expect(status.reason).toBeTruthy();
      expect(status.detail?.length ?? 0).toBeGreaterThan(10);
    }
  });
});
