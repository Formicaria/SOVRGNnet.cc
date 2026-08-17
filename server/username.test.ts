import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkUsername,
  foldUsername,
  isLegalLocalpart,
  isReservedUsername,
  isValidUsername,
  mxidFits,
  normalizeUsername,
  renameConsequences,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "@shared/username";

describe("what a username may be", () => {
  it("accepts the ordinary shapes people actually pick", () => {
    for (const name of [
      "alice",
      "alice_hart",
      "alice.hart",
      "alice-hart",
      "zwright",
      "a1b2c3",
      "x".repeat(USERNAME_MAX_LENGTH),
      "abc",
    ]) {
      expect(checkUsername(name), name).toMatchObject({ ok: true });
    }
  });

  it("normalises case and surrounding space, and returns what it checked", () => {
    // The returned value is what callers must store. If they store the raw
    // input instead, `Alice` and `alice` become two rows and the unique index
    // never fires.
    const result = checkUsername("  ALICE.Hart  ");
    expect(result).toEqual({ ok: true, username: "alice.hart" });
    expect(normalizeUsername("  ALICE  ")).toBe("alice");
  });

  it("rejects lengths outside the range, with a message that says which", () => {
    expect(checkUsername("")).toMatchObject({ problem: "empty" });
    expect(checkUsername("ab")).toMatchObject({ problem: "too-short" });
    expect(checkUsername("x".repeat(USERNAME_MAX_LENGTH + 1))).toMatchObject({
      problem: "too-long",
    });
    // Length is checked before charset so a pasted essay isn't answered with a
    // complaint about punctuation.
    expect(checkUsername("!".repeat(USERNAME_MAX_LENGTH + 1))).toMatchObject({
      problem: "too-long",
    });
  });

  it("rejects characters that are legal in Matrix but bad in a URL", () => {
    // Every one of these is a valid Matrix localpart. This instance still
    // won't hand them out — see the module comment for why each is excluded.
    for (const name of ["alice/bob", "alice+bob", "alice=bob"]) {
      expect(checkUsername(name), name).toMatchObject({
        problem: "bad-characters",
      });
    }
    for (const name of ["alice bob", "alice@bob", "aliceé", "alice!"]) {
      expect(checkUsername(name), name).toMatchObject({
        problem: "bad-characters",
      });
    }
  });

  it("requires a letter first and an alphanumeric last", () => {
    expect(checkUsername("7alice")).toMatchObject({ problem: "bad-start" });
    expect(checkUsername("_alice")).toMatchObject({ problem: "bad-start" });
    expect(checkUsername(".alice")).toMatchObject({ problem: "bad-start" });
    expect(checkUsername("alice_")).toMatchObject({ problem: "bad-end" });
    expect(checkUsername("alice.")).toMatchObject({ problem: "bad-end" });
    expect(checkUsername("alice1")).toMatchObject({ ok: true });
  });

  it("rejects doubled separators", () => {
    expect(checkUsername("alice__hart")).toMatchObject({
      problem: "doubled-separator",
    });
    expect(checkUsername("alice.-hart")).toMatchObject({
      problem: "doubled-separator",
    });
  });
});

describe("names nobody may register", () => {
  it("refuses the obvious authority words", () => {
    for (const name of ["admin", "root", "system", "support", "moderator"]) {
      expect(isReservedUsername(name), name).toBe(true);
      expect(checkUsername(name), name).toMatchObject({ problem: "reserved" });
    }
  });

  it("refuses them spelled with lookalike digits", () => {
    // The whole point of checking the folded form. A blocklist compared
    // against raw input stops only people who aren't trying.
    for (const name of ["adm1n", "s0vrgn", "r00t", "supp0rt", "0fficial"]) {
      expect(isReservedUsername(name), name).toBe(true);
    }
  });

  it("refuses them spelled with separators", () => {
    for (const name of ["a.d.m.i.n", "s-o-v-r-g-n", "sup_port"]) {
      expect(isReservedUsername(name), name).toBe(true);
    }
  });

  it("refuses the whole legacy sovrgn_ localpart prefix", () => {
    // Accounts predating usernames hold the MXID `@sovrgn_<id>:server`, and
    // Matrix has no rename — those localparts are taken forever. Letting
    // someone register the username `sovrgn_7` would derive that same MXID.
    expect(isReservedUsername("sovrgn_7")).toBe(true);
    expect(isReservedUsername("sovrgn_1234")).toBe(true);
    expect(isReservedUsername("sovrgn_anything")).toBe(true);
    // Reserved by prefix regardless of which ids were ever actually issued.
    expect(isReservedUsername("sovrgn_99999999")).toBe(true);
  });

  it("leaves ordinary names alone", () => {
    for (const name of ["alice", "adminy", "administrating", "sovrgnfan"]) {
      expect(isReservedUsername(name), name).toBe(false);
    }
  });
});

describe("legal localpart, separately from allowed username", () => {
  it("accepts anything checkUsername accepts", () => {
    // Necessarily weaker, never stronger. If it could reject a name the policy
    // allowed, registration would mint an account that then cannot be used.
    for (const name of ["alice", "alice.hart", "alice_hart", "abc", "a1b2c3"]) {
      expect(checkUsername(name).ok, name).toBe(true);
      expect(isLegalLocalpart(name), name).toBe(true);
    }
  });

  it("accepts names policy refuses but the protocol permits", () => {
    // The point of the split. Policy can tighten; a Matrix ID is permanent, so
    // the check that runs on every login must not. Each of these is rejected at
    // registration and must still resolve for whoever already holds it.
    for (const name of ["admin", "ab", "7alice", "alice_", "a__b", "sovrgn_7"]) {
      expect(checkUsername(name).ok, name).toBe(false);
      expect(isLegalLocalpart(name), name).toBe(true);
    }
  });

  it("rejects what could never be a localpart", () => {
    for (const name of ["", "Alice", "alice bob", "alice@bob", "alice/bob", "x".repeat(33)]) {
      expect(isLegalLocalpart(name), JSON.stringify(name)).toBe(false);
    }
  });
});

describe("the uniqueness key", () => {
  it("folds separators together", () => {
    const forms = ["alice.hart", "alice_hart", "alice-hart", "alicehart"];
    const folded = new Set(forms.map(foldUsername));
    expect(folded.size, `${forms.join(" ")} should be one name`).toBe(1);
  });

  it("folds the letter and digit pairs that are unreliable at UI sizes", () => {
    expect(foldUsername("bob")).toBe(foldUsername("b0b"));
    expect(foldUsername("lena")).toBe(foldUsername("1ena"));
    expect(foldUsername("ill")).toBe(foldUsername("111"));
  });

  it("keeps genuinely different names apart", () => {
    expect(foldUsername("alice")).not.toBe(foldUsername("alicia"));
    expect(foldUsername("hart")).not.toBe(foldUsername("harte"));
  });

  it("is not the stored form", () => {
    // The fold decides collisions; it is never what a person is shown. If
    // these were the same, everyone's name would display with digits in it.
    const result = checkUsername("alice.hart");
    expect(result).toMatchObject({ ok: true, username: "alice.hart" });
    expect(foldUsername("alice.hart")).toBe("a11cehart");
  });
});

describe("the Matrix ID has to fit", () => {
  it("accepts a normal name on a normal server", () => {
    expect(mxidFits("alice", "chat.example.com")).toBe(true);
    expect(mxidFits("x".repeat(USERNAME_MAX_LENGTH), "e2e.local")).toBe(true);
  });

  it("rejects when the server name is what overflows it", () => {
    // USERNAME_MAX_LENGTH alone can't guarantee a legal MXID: the limit is on
    // `@localpart:servername` as a whole, so an absurd server name breaks it
    // no matter how short the username is.
    const huge = `${"a".repeat(250)}.example`;
    expect(mxidFits("alice", huge)).toBe(false);
  });

  it("counts bytes rather than characters", () => {
    // The 255 limit is on the wire format. A server name of multi-byte
    // characters costs more than its length suggests.
    const multibyte = "é".repeat(200);
    expect(multibyte.length).toBeLessThan(255);
    expect(mxidFits("alice", multibyte)).toBe(false);
  });
});

describe("one implementation, not two", () => {
  it("agrees with itself across the convenience wrapper", () => {
    // isValidUsername exists so callers that only want a boolean don't
    // reimplement the check. If it ever disagrees with checkUsername, the
    // form and the server can disagree too.
    for (const name of ["alice", "admin", "ab", "7alice", "alice_", "x/y"]) {
      expect(isValidUsername(name), name).toBe(checkUsername(name).ok);
    }
  });

  it("has a minimum below its maximum", () => {
    expect(USERNAME_MIN_LENGTH).toBeLessThan(USERNAME_MAX_LENGTH);
  });

  it("agrees with the width of the database columns", () => {
    // drizzle reads the schema file to diff migrations, so the column width is
    // written there as a literal rather than imported from here. That makes
    // these two numbers a coupling nothing else would notice: raise the
    // constant alone and registration starts failing on a string truncation
    // error from Postgres instead of a message anyone can act on.
    const schema = readFileSync(
      join(__dirname, "..", "drizzle", "schema.ts"),
      "utf8"
    );
    for (const column of ["username", "usernameFold"]) {
      expect(
        schema,
        `${column} column must be varchar(${USERNAME_MAX_LENGTH})`
      ).toContain(`${column}: varchar("${column}", { length: ${USERNAME_MAX_LENGTH} })`);
    }
  });

  it("refuses to add usernames to a populated table without a backfill", () => {
    // 0009 makes two NOT NULL columns. On a table with rows that is a raw
    // Postgres error about null values, which tells an operator nothing about
    // why no username was invented for them. The guard turns it into a
    // sentence. If someone regenerates this migration, the guard is the part
    // that gets silently dropped.
    const migration = readFileSync(
      join(__dirname, "..", "drizzle", "0009_big_blizzard.sql"),
      "utf8"
    );
    expect(migration).toContain('IF EXISTS (SELECT 1 FROM "users")');
    expect(migration).toContain("RAISE EXCEPTION");
    expect(migration.indexOf("RAISE EXCEPTION")).toBeLessThan(
      migration.indexOf('ADD COLUMN "username"')
    );
  });
});

describe("renameConsequences", () => {
  const withAccount = () =>
    renameConsequences({
      currentMatrixId: "@alice:example.org",
      newUsername: "bob",
    });

  const text = (list: ReturnType<typeof renameConsequences>) =>
    list.map(c => `${c.headline} ${c.detail}`).join("\n");

  it("names the Matrix address that is staying behind", () => {
    // The load-bearing disclosure. If a rename dialog can be shown without
    // this string in it, the software is implying the rename did more than it
    // did — which is the exact failure ADR 0012 exists to prevent.
    expect(text(withAccount())).toContain("@alice:example.org");
  });

  it("says already-sent messages keep the old name", () => {
    // Someone renaming for safety reasons is usually trying to stop being
    // findable under the old name. Telling them the address is unchanged but
    // not that their history is, would be a technically-true half answer.
    expect(text(withAccount()).toLowerCase()).toContain("already sent");
  });

  it("warns that the old username is released", () => {
    expect(text(withAccount()).toLowerCase()).toMatch(/someone else can take it/);
  });

  it("does not invent a Matrix address for an account that has none", () => {
    // No Matrix account provisioned yet. There is genuinely nothing permanent
    // to warn about, and displaying a predicted MXID would be its own lie.
    const list = renameConsequences({ currentMatrixId: null, newUsername: "bob" });
    expect(text(list)).not.toContain("@");
    expect(text(list).toLowerCase()).not.toContain("matrix");
    // Still says the useful things.
    expect(text(list)).toContain("bob");
    expect(list.length).toBeGreaterThan(0);
  });

  it("leads with plain language, not protocol nouns", () => {
    // headline is what people actually read. "Matrix address" is allowed
    // because it is the name of the thing; "localpart" and "MXID" are not.
    for (const c of withAccount()) {
      expect(c.headline.toLowerCase()).not.toMatch(/localpart|mxid|homeserver/);
    }
  });
});
