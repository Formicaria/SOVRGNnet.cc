import { describe, expect, it } from "vitest";
import { APP_VERSION } from "@shared/const";
import {
  inviteDeepLink,
  inviteUrl,
  isValidInviteCode,
  parseInvite,
  serverBaseUrl,
} from "@shared/invite";
import { instanceId } from "./instance";

describe("invite codes", () => {
  it("accepts what nanoid(10) produces", () => {
    expect(isValidInviteCode("V1StGXR8_Z")).toBe(true);
    expect(isValidInviteCode("abc-DEF_123")).toBe(true);
  });

  it("rejects codes that are too short or too long", () => {
    expect(isValidInviteCode("abc")).toBe(false);
    expect(isValidInviteCode("a".repeat(33))).toBe(false);
  });

  it("rejects anything with path or query characters", () => {
    // These are the ones that would let a code smuggle in a different route.
    expect(isValidInviteCode("abc/def")).toBe(false);
    expect(isValidInviteCode("abc?x=1")).toBe(false);
    expect(isValidInviteCode("../../etc")).toBe(false);
    expect(isValidInviteCode("abc def")).toBe(false);
  });
});

describe("building invite links", () => {
  it("uses https for a real domain", () => {
    expect(inviteUrl("chat.example.com", "abc123")).toBe(
      "https://chat.example.com/invite/abc123"
    );
  });

  it("uses http for localhost and LAN addresses", () => {
    expect(inviteUrl("localhost:3000", "abc123")).toBe("http://localhost:3000/invite/abc123");
    expect(inviteUrl("192.168.1.50:3000", "abc123")).toBe(
      "http://192.168.1.50:3000/invite/abc123"
    );
    expect(inviteUrl("sovrgn.local", "abc123")).toBe("http://sovrgn.local/invite/abc123");
  });

  it("builds a deep link naming both server and code", () => {
    expect(inviteDeepLink("chat.example.com", "abc123")).toBe(
      "sovrgn://invite/chat.example.com/abc123"
    );
  });
});

describe("parsing invites", () => {
  it("parses the canonical https link", () => {
    expect(parseInvite("https://chat.example.com/invite/abc123")).toEqual({
      host: "chat.example.com",
      code: "abc123",
      secure: true,
    });
  });

  it("parses a link with a port", () => {
    expect(parseInvite("http://192.168.1.50:3000/invite/abc123")).toEqual({
      host: "192.168.1.50:3000",
      code: "abc123",
      secure: false,
    });
  });

  it("parses the desktop deep link", () => {
    expect(parseInvite("sovrgn://invite/chat.example.com/abc123")).toEqual({
      host: "chat.example.com",
      code: "abc123",
      secure: true,
    });
  });

  it("tolerates a trailing slash", () => {
    expect(parseInvite("https://chat.example.com/invite/abc123/")?.code).toBe("abc123");
  });

  it("assumes https when someone pastes a bare domain", () => {
    expect(parseInvite("chat.example.com/invite/abc123")).toEqual({
      host: "chat.example.com",
      code: "abc123",
      secure: true,
    });
  });

  it("resolves a bare code against the server you're already on", () => {
    expect(parseInvite("abc123", "chat.example.com")).toEqual({
      host: "chat.example.com",
      code: "abc123",
      secure: true,
    });
  });

  it("refuses a bare code with nothing to resolve it against", () => {
    // The whole point of the new format: a code alone is ambiguous once a
    // client is connected to more than one server.
    expect(parseInvite("abc123")).toBeNull();
  });

  it("returns null for input that isn't an invite", () => {
    expect(parseInvite("")).toBeNull();
    expect(parseInvite("https://example.com/")).toBeNull();
    expect(parseInvite("https://example.com/some/other/path")).toBeNull();
    expect(parseInvite("not a url at all !!")).toBeNull();
  });

  it("rejects a link carrying a malformed code", () => {
    expect(parseInvite("https://chat.example.com/invite/ab")).toBeNull();
    expect(parseInvite("sovrgn://invite/chat.example.com/a")).toBeNull();
  });

  it("round-trips what it builds", () => {
    for (const host of ["chat.example.com", "localhost:3000", "192.168.1.50:3000"]) {
      const parsed = parseInvite(inviteUrl(host, "V1StGXR8_Z"));
      expect(parsed).toMatchObject({ host, code: "V1StGXR8_Z" });
      expect(parseInvite(inviteDeepLink(host, "V1StGXR8_Z"))).toMatchObject({ host });
    }
  });
});

describe("serverBaseUrl", () => {
  it("rebuilds the origin to talk to", () => {
    expect(serverBaseUrl({ host: "chat.example.com", secure: true })).toBe(
      "https://chat.example.com"
    );
    expect(serverBaseUrl({ host: "localhost:3000", secure: false })).toBe(
      "http://localhost:3000"
    );
  });
});

describe("instance identity", () => {
  it("is stable across calls", () => {
    expect(instanceId()).toBe(instanceId());
  });

  it("is a short hex string safe to put in a URL", () => {
    expect(instanceId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("version constant", () => {
  it("matches package.json", async () => {
    // APP_VERSION is what GET /api/instance advertises; if it drifts from the
    // real version, every client's compatibility check is quietly lying.
    const pkg = await import("../package.json");
    expect(APP_VERSION).toBe(pkg.default.version);
  });
});
