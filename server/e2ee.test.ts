import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEGOLM_ALGORITHM,
  deriveE2eeCapability,
  describeDecryptionFailure,
  describeReadiness,
  encryptionStateContent,
  formatRecoveryKey,
  isSupportedEncryption,
  looksLikeRecoveryKey,
  normaliseRecoveryKey,
  type CryptoReadiness,
} from "@shared/e2ee";

/**
 * The parts of stage 4 that can be wrong without any cryptography being wrong.
 *
 * Olm and Megolm are matrix-js-sdk's, and testing them here would be testing
 * somebody else's library. What this file covers is the judgement wrapped
 * around them: what the instance is allowed to claim, what a user is told when
 * a message won't open, and what state gets written to a room. Every one of
 * those has a failure mode that ships silently — a capability that overstates
 * itself, a spinner that never resolves, an algorithm nobody implements.
 */

describe("room encryption state", () => {
  it("only ever writes Megolm v1", () => {
    expect(encryptionStateContent().algorithm).toBe("m.megolm.v1.aes-sha2");
  });

  it("rotates sessions well below the spec's example values", () => {
    const content = encryptionStateContent();
    // A Megolm session is the unit of compromise: every message under one is
    // readable by anyone who gets that session's key. The spec's example of a
    // week and 100 messages is a wide blast radius for a cost nobody notices.
    expect(content.rotation_period_ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(content.rotation_period_msgs).toBeLessThanOrEqual(100);
  });

  it("accepts its own state event", () => {
    expect(isSupportedEncryption(encryptionStateContent())).toBe(true);
  });

  it.each([
    [
      { algorithm: "m.olm.v1.curve25519-aes-sha2" },
      "a per-device algorithm, not a room one",
    ],
    [{ algorithm: "m.megolm.v2.aes-sha2" }, "a version we don't implement"],
    [{}, "no algorithm at all"],
    [null, "null"],
    ["m.megolm.v1.aes-sha2", "a bare string rather than content"],
  ])("rejects %j — %s", (content, _why) => {
    // Treating an unknown algorithm as ordinary encryption would put a lock
    // icon over messages that are never going to decrypt.
    expect(isSupportedEncryption(content)).toBe(false);
  });
});

describe("what a reader is told when a message won't open", () => {
  it("says nothing about a message that decrypted", () => {
    expect(describeDecryptionFailure(null)).toEqual({
      state: "decrypted",
      detail: "",
    });
    expect(describeDecryptionFailure(undefined).state).toBe("decrypted");
  });

  it("treats a missing session as transient, because it is", () => {
    // The key is usually seconds behind the message.
    expect(
      describeDecryptionFailure("MEGOLM_UNKNOWN_INBOUND_SESSION_ID").state
    ).toBe("pending");
  });

  it.each([
    "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE",
    "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED",
    "SENDER_IDENTITY_PREVIOUSLY_VERIFIED",
    "UNSIGNED_SENDER_DEVICE",
  ])("marks %s recoverable, because the reader can act on it", code => {
    expect(describeDecryptionFailure(code).state).toBe("recoverable");
  });

  it.each([
    "MEGOLM_KEY_WITHHELD",
    "HISTORICAL_MESSAGE_NO_KEY_BACKUP",
    "HISTORICAL_MESSAGE_USER_NOT_JOINED",
  ])("marks %s lost, because nothing will fix it here", code => {
    expect(describeDecryptionFailure(code).state).toBe("lost");
  });

  it("calls an unrecognised code lost rather than pending", () => {
    // The bug this prevents: a code we've never seen renders as "waiting for
    // the key" and spins for the lifetime of the session, because there is no
    // key coming and nothing knows that.
    expect(describeDecryptionFailure("SOME_FUTURE_SDK_CODE").state).toBe(
      "lost"
    );
    expect(describeDecryptionFailure("").state).toBe("decrypted");
  });

  it("gives every non-decrypted state something to actually show", () => {
    const codes = [
      "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
      "MEGOLM_KEY_WITHHELD",
      "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE",
      "OLM_UNKNOWN_MESSAGE_INDEX",
      "HISTORICAL_MESSAGE_NO_KEY_BACKUP",
      "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED",
      "HISTORICAL_MESSAGE_WORKING_BACKUP",
      "HISTORICAL_MESSAGE_USER_NOT_JOINED",
      "SENDER_IDENTITY_PREVIOUSLY_VERIFIED",
      "UNSIGNED_SENDER_DEVICE",
      "ANYTHING_ELSE",
    ];
    for (const code of codes) {
      const verdict = describeDecryptionFailure(code);
      // An empty row is indistinguishable from a message someone sent blank.
      expect(verdict.detail, `${code} renders as an empty message`).not.toBe(
        ""
      );
      expect(verdict.state).not.toBe("plaintext");
    }
  });
});

describe("readiness reports the next fix, in the order the fixes work", () => {
  const complete: CryptoReadiness = {
    crossSigningReady: true,
    secretStorageReady: true,
    keyBackupEnabled: true,
    deviceVerified: true,
  };

  it("is ready only when all four hold", () => {
    const verdict = describeReadiness(complete);
    expect(verdict.level).toBe("ready");
    expect(verdict.nextStep).toBeNull();
  });

  it("asks for cross-signing first, whatever else is missing", () => {
    // Nothing else is worth mentioning: setting up cross-signing is what
    // creates the recovery key and the backup the other checks look for.
    const verdict = describeReadiness({
      crossSigningReady: false,
      secretStorageReady: false,
      keyBackupEnabled: false,
      deviceVerified: false,
    });
    expect(verdict.level).toBe("unset");
    expect(verdict.nextStep).toMatch(/set up encryption/i);
  });

  it("asks for verification before recovery or backup", () => {
    const verdict = describeReadiness({ ...complete, deviceVerified: false });
    expect(verdict.headline).toMatch(/isn't verified/i);
  });

  it("asks for a recovery key before key backup", () => {
    const verdict = describeReadiness({
      ...complete,
      secretStorageReady: false,
      keyBackupEnabled: false,
    });
    expect(verdict.headline).toMatch(/recovery key/i);
  });

  it("mentions key backup only when it is the last thing left", () => {
    const verdict = describeReadiness({ ...complete, keyBackupEnabled: false });
    expect(verdict.level).toBe("incomplete");
    expect(verdict.headline).toMatch(/key backup/i);
  });

  it("never reports ready with a next step, or incomplete without one", () => {
    for (const crossSigningReady of [true, false]) {
      for (const secretStorageReady of [true, false]) {
        for (const keyBackupEnabled of [true, false]) {
          for (const deviceVerified of [true, false]) {
            const verdict = describeReadiness({
              crossSigningReady,
              secretStorageReady,
              keyBackupEnabled,
              deviceVerified,
            });
            if (verdict.level === "ready") expect(verdict.nextStep).toBeNull();
            else expect(verdict.nextStep).toBeTruthy();
          }
        }
      }
    }
  });
});

describe("the e2ee capability is derived, not asserted", () => {
  const all = {
    implemented: true,
    homeserverReachable: true,
    eventIngest: true,
  };

  it("is true only when all three hold", () => {
    expect(deriveE2eeCapability(all)).toBe(true);
  });

  it.each([
    ["implemented", { ...all, implemented: false }],
    ["homeserverReachable", { ...all, homeserverReachable: false }],
    ["eventIngest", { ...all, eventIngest: false }],
  ])("is false without %s", (_name, input) => {
    expect(deriveE2eeCapability(input)).toBe(false);
  });

  it("stays false on a loopback deployment however good the build is", () => {
    // The mistake this exists to prevent has been made twice here: `encryption`
    // in v0.3 and `clientMatrix` before stage 2 both turned a deployment
    // detail into a claim, and a client acted on the claim both times. A
    // homeserver clients can't reach is a homeserver whose users can't hold
    // their own keys, whatever the client bundle contains.
    expect(
      deriveE2eeCapability({
        implemented: true,
        homeserverReachable: false,
        eventIngest: true,
      })
    ).toBe(false);
  });

  it("stays false when the instance can't record what its homeserver pushes", () => {
    // Otherwise an encrypted message is invisible to every member whose client
    // is still on the API fallback — not unreadable, absent.
    expect(
      deriveE2eeCapability({
        implemented: true,
        homeserverReachable: true,
        eventIngest: false,
      })
    ).toBe(false);
  });
});

describe("recovery keys", () => {
  // 58 base58 characters, the shape the spec's encoding produces.
  const KEY = "EsT9NDitLuBjMdvyC7yLtLTRxwYQBjX8VCr8AsGYJjnhX1uMwGYbjMR";

  it("strips the display grouping, which was never part of the key", () => {
    expect(normaliseRecoveryKey("EsT9 NDit LuBj")).toBe("EsT9NDitLuBj");
  });

  it("survives a paste from a password manager", () => {
    // Newlines and tabs, not just spaces.
    expect(normaliseRecoveryKey("EsT9\nNDit\tLuBj  ")).toBe("EsT9NDitLuBj");
  });

  it("accepts a well-formed key with or without grouping", () => {
    expect(looksLikeRecoveryKey(KEY)).toBe(true);
    expect(looksLikeRecoveryKey(formatRecoveryKey(KEY))).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["hunter2", "too short"],
    [`${KEY}${KEY}`, "too long"],
    [
      "EsT9NDitLuBjMdvyC7yLtLTRxwYQBjX8VCr8AsGYJjnh0OIl",
      "contains base58's excluded glyphs",
    ],
    ["not a recovery key at all, just a sentence", "prose"],
  ])("rejects %j — %s", (input, _why) => {
    // A shape check, so a typo fails immediately instead of surfacing as a
    // decryption error half a minute later.
    expect(looksLikeRecoveryKey(input)).toBe(false);
  });

  it("groups in fours for display and round-trips", () => {
    const shown = formatRecoveryKey(KEY);
    expect(shown.split(" ")[0]).toHaveLength(4);
    expect(normaliseRecoveryKey(shown)).toBe(KEY);
  });
});

describe("shared/e2ee.ts stays dependency-free", () => {
  it("imports nothing at all", () => {
    // It runs in the browser, in the desktop shell, in the server and in this
    // file. The same rule protocol.ts lives under, for the same reason: the
    // moment it needs zod or node:crypto, one of those four stops working —
    // and TypeScript will not be the thing that tells you.
    const source = readFileSync(
      join(__dirname, "..", "shared", "e2ee.ts"),
      "utf8"
    );
    const imports = source.match(
      /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["']/g
    );
    expect(imports ?? []).toEqual([]);
  });

  it("exports the algorithm constant the server writes and the client checks", () => {
    expect(MEGOLM_ALGORITHM).toBe("m.megolm.v1.aes-sha2");
  });
});

describe("the landing page agrees with what shipped", () => {
  const home = readFileSync(
    join(__dirname, "..", "client", "src", "pages", "Home.tsx"),
    "utf8"
  );

  it("does not file end-to-end encryption under 'Not yet'", () => {
    // Every other honesty check in this repository points one way: stop the
    // instance claiming more than it does. This one points the other way, and
    // it caught a real regression — the encryption shipped and the marketing
    // page kept saying "Not yet end-to-end encrypted — whoever runs this
    // server can read them" for a release afterwards.
    //
    // A stale disclaimer is not the cautious option. It is the same defect
    // with the sign flipped, it sits on the first screen anyone sees, and it
    // tells people to be careful in a way that is no longer true — which is
    // its own kind of lie about a security property.
    const notYet = home.slice(home.indexOf("Not yet"));
    expect(notYet).not.toMatch(/"End-to-end encryption"/);
    expect(home).toMatch(/End-to-end encrypted messages and files/);
  });

  it("still says what the encryption does not hide", () => {
    // Promoting the claim without its limit would be the overstatement this
    // file exists to prevent. The server cannot read the messages; it can
    // still see the room, the members, and the timing.
    //
    // Whitespace collapsed first: JSX wraps prose across lines, so matching
    // sentences against the raw source tests the prettier config, not the copy.
    const prose = home.replace(/\s+/g, " ");
    expect(prose).toMatch(/hides what you said, not that you said it/);
  });
});

describe("the browser stage asks for the verdicts that exist", () => {
  it("lists every headline describeReadiness can return", () => {
    // The browser test matches the verdict by its exact sentence, because the
    // loose pattern it started with also matched the panel's explanatory prose
    // — text that renders whether or not the crypto machine answered — and so
    // passed on a stack where the whole crypto stack was unreachable.
    //
    // Exactness bought precision and a drift risk: a headline reworded here
    // would quietly stop being asserted there, and the browser stage would go
    // green on a panel it could no longer read. This is the cheap half of that
    // trade, run every time rather than only when a stack is up.
    const spec = readFileSync(
      join(__dirname, "..", "scripts", "e2e-browser.spec.ts"),
      "utf8"
    );

    const states: Partial<CryptoReadiness>[] = [
      { crossSigningReady: false },
      { crossSigningReady: true, deviceVerified: false },
      { crossSigningReady: true, deviceVerified: true, secretStorageReady: false },
      {
        crossSigningReady: true,
        deviceVerified: true,
        secretStorageReady: true,
        keyBackupEnabled: false,
      },
      {
        crossSigningReady: true,
        deviceVerified: true,
        secretStorageReady: true,
        keyBackupEnabled: true,
      },
    ];

    const missing = states
      .map(state =>
        describeReadiness({
          crossSigningReady: false,
          secretStorageReady: false,
          keyBackupEnabled: false,
          deviceVerified: false,
          ...state,
        }).headline
      )
      .filter(headline => !spec.includes(headline.replace(/\./g, "\\.")));

    expect(
      missing,
      "the browser stage cannot recognise these verdicts; it would pass on a panel showing one of them"
    ).toEqual([]);
  });
});

describe("the encryption setup can be reached, not just seen", () => {
  const dashboard = readFileSync(
    join(__dirname, "..", "client", "src", "pages", "Dashboard.tsx"),
    "utf8"
  );

  /**
   * Every tooltip-wrapped control in the left rail, as source text.
   *
   * Sliced on the element boundary rather than matched with a windowed regex.
   * The first version used `[\s\S]{0,900}?>` and reported the encryption button
   * unnamed while it was sitting there named — the window was shorter than the
   * comment above the attribute, and `>` closes early on the `=>` in `onClick`.
   * A guard that fails on comment length is measuring the wrong thing.
   */
  function railTriggers(): string[] {
    const rail = dashboard.slice(
      dashboard.indexOf("<aside"),
      dashboard.indexOf("</aside>")
    );
    return rail
      .split("<TooltipTrigger asChild>")
      .slice(1)
      .map(part => part.slice(0, part.indexOf("</TooltipTrigger>")))
      .filter(part => /^\s*<button\b/.test(part));
  }

  it("names the button that opens the encryption panel", () => {
    // The rail is icon-only and every label in it lived in a Radix tooltip,
    // which is not an accessible name — it enters the DOM on hover and leaves
    // again, so at rest each control announced as "button" and nothing more.
    //
    // The rest of this file guards against the instance *claiming* more
    // protection than it has. This guards the opposite failure: the protection
    // is real and the only door to it is unmarked. Device verification and the
    // recovery key both sit behind this one button, and losing the recovery
    // key loses every message already received — permanently, by design,
    // because the server genuinely cannot get it back for you. A door that
    // opens only to a mouse hover puts that whole story out of reach of
    // anyone using a screen reader.
    //
    // Asserted against the source rather than a render because the claim worth
    // making is "the label is on the control". The browser stage, which found
    // this, is opt-in and needs a live stack; this runs every time.
    const opener = railTriggers().filter(button =>
      button.includes("setEncryptionPanelOpen(true)")
    );

    expect(
      opener,
      "no button in the rail opens the encryption panel"
    ).toHaveLength(1);
    expect(opener[0]).toMatch(/aria-label="Encryption"/);
  });

  it("leaves no icon-only button in the rail unnamed", () => {
    // Six of them, one cause. Counting rather than listing each: a seventh
    // added the same way should fail this too, which is the only version of
    // the check that keeps working after today.
    const triggers = railTriggers();
    const unnamed = triggers.filter(button => !/aria-label=/.test(button));

    expect(
      triggers.length,
      "no tooltip-wrapped buttons found — did the rail move out of <aside>?"
    ).toBeGreaterThan(0);
    expect(
      unnamed.map(button => button.slice(0, 200)),
      "a tooltip-wrapped button in the rail has no aria-label; the tooltip is not its name"
    ).toEqual([]);
  });
});
