import { describe, expect, it, vi } from "vitest";
import { DeepLinkQueue, routeDeepLink } from "@shared/deeplink";

describe("routeDeepLink", () => {
  it("routes an invite link", () => {
    const action = routeDeepLink("sovrgn://invite/chat.example.com/abc123");
    expect(action).toEqual({
      kind: "invite",
      invite: { host: "chat.example.com", code: "abc123", secure: true },
    });
  });

  it("routes a server link", () => {
    expect(routeDeepLink("sovrgn://server/chat.example.com")).toEqual({
      kind: "server",
      host: "chat.example.com",
      secure: true,
    });
  });

  it("treats LAN and localhost servers as insecure", () => {
    expect(routeDeepLink("sovrgn://server/192.168.1.50:3000")).toMatchObject({
      secure: false,
    });
    expect(routeDeepLink("sovrgn://server/localhost:3000")).toMatchObject({
      secure: false,
    });
  });

  it("is case-insensitive about the scheme", () => {
    expect(routeDeepLink("SOVRGN://invite/chat.example.com/abc123").kind).toBe("invite");
  });

  it("tolerates surrounding whitespace", () => {
    // Deep links arrive from clipboards and command lines.
    expect(routeDeepLink("  sovrgn://server/chat.example.com  ").kind).toBe("server");
  });

  describe("input it should refuse", () => {
    it("rejects another app's scheme", () => {
      expect(routeDeepLink("https://chat.example.com/invite/abc123").kind).toBe("unknown");
      expect(routeDeepLink("file:///etc/passwd").kind).toBe("unknown");
    });

    it("rejects an unknown action", () => {
      expect(routeDeepLink("sovrgn://wipe-everything/now").kind).toBe("unknown");
    });

    it("rejects a malformed invite rather than throwing", () => {
      // A code too short to be real shouldn't crash the app on launch.
      expect(routeDeepLink("sovrgn://invite/chat.example.com/x").kind).toBe("unknown");
      expect(routeDeepLink("sovrgn://invite/").kind).toBe("unknown");
    });

    it("rejects empty and nonsense input", () => {
      expect(routeDeepLink("").kind).toBe("unknown");
      expect(routeDeepLink("   ").kind).toBe("unknown");
      expect(routeDeepLink("not a url").kind).toBe("unknown");
    });

    it("preserves the raw input so the UI can show what failed", () => {
      const action = routeDeepLink("sovrgn://nonsense");
      expect(action).toEqual({ kind: "unknown", raw: "sovrgn://nonsense" });
    });
  });
});

describe("DeepLinkQueue", () => {
  it("delivers a link straight through once listening", () => {
    const queue = new DeepLinkQueue();
    const handler = vi.fn();
    queue.onLink(handler);

    queue.push("sovrgn://server/chat.example.com");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "server", host: "chat.example.com" })
    );
  });

  it("holds links that arrive before anything is listening", () => {
    // The cold-start case: clicking an invite launches the app, and the URL
    // lands before React has mounted.
    const queue = new DeepLinkQueue();
    queue.push("sovrgn://server/chat.example.com");
    expect(queue.pendingCount).toBe(1);

    const handler = vi.fn();
    queue.onLink(handler);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount).toBe(0);
  });

  it("drains queued links in arrival order", () => {
    const queue = new DeepLinkQueue();
    queue.push("sovrgn://server/a.example.com");
    queue.push("sovrgn://server/b.example.com");

    const seen: string[] = [];
    queue.onLink(action => {
      if (action.kind === "server") seen.push(action.host);
    });

    expect(seen).toEqual(["a.example.com", "b.example.com"]);
  });

  it("stops delivering after unsubscribe", () => {
    const queue = new DeepLinkQueue();
    const handler = vi.fn();
    const off = queue.onLink(handler);
    off();

    queue.push("sovrgn://server/chat.example.com");
    expect(handler).not.toHaveBeenCalled();
    expect(queue.pendingCount).toBe(1);
  });

  it("still routes links it can't understand, so the UI can complain", () => {
    const queue = new DeepLinkQueue();
    const handler = vi.fn();
    queue.onLink(handler);

    queue.push("sovrgn://garbage");
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unknown" })
    );
  });
});
