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
