import { describe, expect, it } from "vitest";
import { displayName } from "./db";

/**
 * Per-server profiles: one account, but a different name per community.
 * The fallback rules are small and easy to get subtly wrong, which is exactly
 * the kind of thing that ends up rendering a blank message author.
 */
describe("displayName", () => {
  it("prefers the per-server nickname", () => {
    expect(displayName("chronus", "Zachary")).toBe("chronus");
  });

  it("falls back to the account name when there's no nickname", () => {
    expect(displayName(null, "Zachary")).toBe("Zachary");
    expect(displayName(undefined, "Zachary")).toBe("Zachary");
  });

  it("treats an empty or whitespace nickname as unset", () => {
    // Otherwise clearing a nickname renders an author with no name at all.
    expect(displayName("", "Zachary")).toBe("Zachary");
    expect(displayName("   ", "Zachary")).toBe("Zachary");
    expect(displayName("\t\n", "Zachary")).toBe("Zachary");
  });

  it("trims a nickname rather than rendering the padding", () => {
    expect(displayName("  chronus  ", "Zachary")).toBe("chronus");
  });

  it("returns null when there is nothing to show", () => {
    // The caller decides what "Unknown" looks like; this doesn't invent one.
    expect(displayName(null, null)).toBeNull();
    expect(displayName("  ", null)).toBeNull();
  });

  it("uses a nickname even when the account has no name", () => {
    expect(displayName("chronus", null)).toBe("chronus");
  });

  it("keeps names that are only unusual, not empty", () => {
    expect(displayName("_", "Zachary")).toBe("_");
    expect(displayName("🦀", "Zachary")).toBe("🦀");
  });
});

describe("displayName falls back to the username", () => {
  it("prefers nickname, then account name, then username", () => {
    expect(displayName("Nick", "Account", "uname")).toBe("Nick");
    expect(displayName(null, "Account", "uname")).toBe("Account");
    expect(displayName(null, null, "uname")).toBe("uname");
  });

  it("gives a local account with no display name a name to show", () => {
    // Before usernames existed this returned null, and the member list showed
    // "Unknown" while the message list showed the raw MXID — to the person's
    // own community, for the crime of not filling in an optional field.
    expect(displayName(null, null, "alice")).toBe("alice");
    expect(displayName("  ", null, "alice")).toBe("alice");
  });

  it("still returns null when there is nothing at all", () => {
    // A federated sender: no local row, so no name and no username. The caller
    // substitutes the Matrix ID, which is the honest answer there (ADR 0010).
    expect(displayName(null, null, null)).toBeNull();
    expect(displayName(null, null)).toBeNull();
    expect(displayName(undefined, undefined, undefined)).toBeNull();
  });
});
