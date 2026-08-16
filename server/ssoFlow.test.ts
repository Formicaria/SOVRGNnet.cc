import { describe, expect, it, vi } from "vitest";
import {
  buildReturnRedirect,
  parseReturnUrl,
  readTokenFromFragment,
  resolveReturnTarget,
} from "@shared/ssoFlow";

function instanceResponse(body: unknown, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 404, json: async () => body })) as unknown as typeof fetch;
}

const realServer = {
  product: "sovrgnnet",
  id: "abc123def4567890",
  name: "Zach's server",
};

describe("parseReturnUrl", () => {
  it("accepts https", () => {
    expect(parseReturnUrl("https://chat.example.com/sso")?.origin).toBe(
      "https://chat.example.com"
    );
  });

  it("accepts http only for local addresses", () => {
    expect(parseReturnUrl("http://localhost:3000/sso")?.origin).toBe("http://localhost:3000");
    expect(parseReturnUrl("http://192.168.1.50:3000/sso")?.origin).toBe(
      "http://192.168.1.50:3000"
    );
  });

  it("refuses plain http on the public internet", () => {
    // A token in a fragment over http is a token on the wire.
    expect(parseReturnUrl("http://chat.example.com/sso")).toBeNull();
  });

  it("refuses schemes that aren't the web", () => {
    for (const bad of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,hi",
      "not a url",
      "",
    ]) {
      expect(parseReturnUrl(bad)).toBeNull();
    }
  });
});

describe("resolveReturnTarget", () => {
  it("takes the audience from the destination, not from the caller", async () => {
    const target = await resolveReturnTarget(
      "https://chat.example.com/sso/callback",
      instanceResponse(realServer)
    );

    expect(target).toEqual({
      ok: true,
      origin: "https://chat.example.com",
      instanceId: "abc123def4567890",
      instanceName: "Zach's server",
    });
  });

  it("asks the origin being returned to, and only that", async () => {
    const fetchImpl = instanceResponse(realServer);
    await resolveReturnTarget("https://chat.example.com/deep/path?x=1", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://chat.example.com/api/instance",
      expect.anything()
    );
  });

  describe("the takeover it prevents", () => {
    it("won't mint a token for a server that isn't receiving it", async () => {
      // An attacker points the return URL at their own site. Their site is not
      // the victim's server, so the id that comes back is their own — and a
      // token for their server is worthless against anyone else's.
      const attacker = await resolveReturnTarget(
        "https://evil.example.com/steal",
        instanceResponse({ product: "sovrgnnet", id: "9999888877776666", name: "Evil" })
      );

      expect(attacker).toMatchObject({ ok: true, instanceId: "9999888877776666" });
      // The point: it is NOT the victim's id, so nothing was stolen.
      expect(attacker).not.toMatchObject({ instanceId: "abc123def4567890" });
    });

    it("refuses a destination that isn't a SOVRGNnet server at all", async () => {
      const target = await resolveReturnTarget(
        "https://evil.example.com/steal",
        instanceResponse({ hello: "world" })
      );
      expect(target).toMatchObject({ ok: false, reason: "not_a_sovrgnnet_server" });
    });

    it("refuses a destination that returns an error", async () => {
      const target = await resolveReturnTarget(
        "https://evil.example.com/steal",
        instanceResponse({}, false)
      );
      expect(target).toMatchObject({ ok: false, reason: "not_a_sovrgnnet_server" });
    });

    it("refuses a malformed instance id", async () => {
      // Anything that isn't the expected shape can't become an audience.
      const target = await resolveReturnTarget(
        "https://evil.example.com/steal",
        instanceResponse({ product: "sovrgnnet", id: "../../etc/passwd" })
      );
      expect(target).toMatchObject({ ok: false, reason: "not_a_sovrgnnet_server" });
    });
  });

  it("reports an unreachable destination distinctly", async () => {
    const failing = vi.fn(async () => {
      throw new Error("nope");
    }) as unknown as typeof fetch;

    expect(await resolveReturnTarget("https://chat.example.com/sso", failing)).toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });

  it("rejects a bad return URL before making any request", async () => {
    const fetchImpl = instanceResponse(realServer);
    expect(await resolveReturnTarget("javascript:alert(1)", fetchImpl)).toMatchObject({
      ok: false,
      reason: "not_a_url",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("handing the token back", () => {
  it("puts it in the fragment, not the query string", () => {
    // Fragments aren't sent to servers, don't appear in access logs, and don't
    // leak through Referer.
    const redirect = buildReturnRedirect("https://chat.example.com/sso/callback", "tok_abc");
    expect(redirect).toBe("https://chat.example.com/sso/callback#token=tok_abc");
    expect(redirect).not.toContain("?token");
  });

  it("preserves an existing query string", () => {
    expect(buildReturnRedirect("https://chat.example.com/sso?next=%2Fdashboard", "t")).toBe(
      "https://chat.example.com/sso?next=%2Fdashboard#token=t"
    );
  });

  it("replaces any fragment already there", () => {
    expect(buildReturnRedirect("https://chat.example.com/sso#stale", "fresh")).toBe(
      "https://chat.example.com/sso#token=fresh"
    );
  });

  it("escapes a token containing URL characters", () => {
    const redirect = buildReturnRedirect("https://chat.example.com/x", "a+b/c=d");
    expect(readTokenFromFragment(new URL(redirect).hash)).toBe("a+b/c=d");
  });

  it("refuses to build a redirect to somewhere unsafe", () => {
    expect(() => buildReturnRedirect("javascript:alert(1)", "tok")).toThrow(/invalid/i);
  });
});

describe("readTokenFromFragment", () => {
  it("reads the token with or without the leading hash", () => {
    expect(readTokenFromFragment("#token=abc")).toBe("abc");
    expect(readTokenFromFragment("token=abc")).toBe("abc");
  });

  it("finds it alongside other fragment parameters", () => {
    expect(readTokenFromFragment("#state=xyz&token=abc")).toBe("abc");
  });

  it("returns null when there's nothing to read", () => {
    for (const empty of ["", "#", "#other=1", "#token="]) {
      expect(readTokenFromFragment(empty)).toBeNull();
    }
  });
});
