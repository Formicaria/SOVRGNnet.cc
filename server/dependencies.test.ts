import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards for the dependency advisories we chose not to fix by upgrading.
 *
 * `docs/DEPENDENCIES.md` records eight remaining advisories and, for each, why
 * it is either unreachable or not worth the migration yet. Two of those
 * arguments are about *how this code calls the library*, which means they can
 * stop being true silently, in a commit that has nothing to do with security.
 *
 * These tests make the reachability argument executable. If one fails, the
 * corresponding paragraph in DEPENDENCIES.md has become fiction and the
 * advisory needs re-triaging rather than the test needs relaxing.
 */

const ROOT = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "ui") continue;
      out.push(...sourceFiles(join(dir, entry.name)));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

describe("nanoid is never called with a size we don't control", () => {
  it("passes a positive integer literal, or nothing", () => {
    // GHSA high: nanoid's non-secure generator loops forever on a *negative*
    // size. We stayed on nanoid 5 rather than take a major bump for it, and
    // that is only defensible while every call site passes a literal — a
    // `nanoid(n)` where n came from a request would make an unbounded loop
    // reachable from the network, which is a denial of service on the whole
    // process rather than one request.
    const offenders: string[] = [];

    for (const file of [
      ...sourceFiles("server"),
      ...sourceFiles("shared"),
      ...sourceFiles("client/src"),
    ]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const match of text.matchAll(/\bnanoid\(([^)]*)\)/g)) {
        const argument = match[1].trim();
        // Empty (default size) or a bare positive integer are both fine.
        if (argument === "" || /^[1-9][0-9]*$/.test(argument)) continue;
        offenders.push(`${file}: nanoid(${argument})`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("the scaffold dependencies stay gone", () => {
  const packageJson = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };

  // Each of these arrived with a shadcn/ui component nothing imported, and each
  // was a production dependency in the shipped bundle. axios is the one that
  // mattered: it was 26 of the 43 advisories on its own, and the only file
  // importing it would have POSTed plaintext file bytes to Kubo's
  // unauthenticated API, bypassing the client-side encryption entirely.
  //
  // Listed by name rather than counted, so re-adding one is a decision someone
  // has to make on purpose.
  const removed = [
    "axios",
    "recharts",
    "embla-carousel-react",
    "vaul",
    "input-otp",
    "react-resizable-panels",
  ];

  for (const dep of removed) {
    it(`does not depend on ${dep}`, () => {
      expect(packageJson.dependencies ?? {}).not.toHaveProperty(dep);
    });
  }

  it("has no import of them left anywhere", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles("client/src"), ...sourceFiles("server")]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const dep of removed) {
        // Match an actual import specifier, not the word in a comment — this
        // file and App.tsx both explain why these are gone.
        if (new RegExp(`from ["']${dep}["']`).test(text)) {
          offenders.push(`${file} imports ${dep}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the identity origin is written once", () => {
  it("has no stray sovrgnnet.cc literal outside the shared constant", () => {
    // Four places held this string independently: TOKEN_ISSUER, two
    // IDENTITY_ISSUER defaults, and the desktop's IDENTITY_URL. They pointed at
    // the Cloudflare Pages marketing site, so the desktop's sign-in POST got a
    // 405 from a static host and every instance enabling SSO fetched JWKS from
    // a page with no keys.
    //
    // One copy can be wrong and get fixed. Four copies get fixed one at a time,
    // over months, as each is discovered separately.
    const offenders: string[] = [];
    for (const file of [
      ...sourceFiles("server"),
      ...sourceFiles("shared"),
      ...sourceFiles("desktop/src"),
    ]) {
      // shared/identityOrigin.ts is where the constant lives. It moved out of
      // shared/identity.ts because that module imports node:crypto, and the
      // desktop pulling one constant from it broke the browser bundle.
      if (file.endsWith(join("shared", "identityOrigin.ts"))) continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const [index, line] of text.split("\n").entries()) {
        const code = line.split("//")[0];
        // A quoted origin, not a mention in prose or a keychain key.
        if (/["'`]https?:\/\/(www\.)?sovrgnnet\.cc/.test(code)) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
