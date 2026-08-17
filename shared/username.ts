/**
 * What a username may be.
 *
 * This lives in shared/ because the browser and the server have to agree
 * exactly. If the form accepts a name the server later rejects, the person
 * finds out after choosing a password; if the form rejects one the server
 * would have taken, the name is simply unavailable for no stated reason. Two
 * implementations of "is this allowed" is how that pair of bugs is born.
 *
 * A username here is not a display name. It is the account's identity: it
 * becomes the Matrix localpart (see task #31), it is what people type to find
 * each other, and it is what someone reads to decide whether the account
 * messaging them is who it claims to be. Display names stay free-form and
 * changeable; this does not.
 *
 * ## Why a subset of what Matrix allows
 *
 * The Matrix specification permits `[a-z] [0-9] . _ = - / +` in a localpart.
 * This module allows `[a-z0-9._-]` and drops the other three:
 *
 *   `/`  breaks URL path segments, so `/u/alice/bob` is ambiguous
 *   `+`  is meaningful in query strings and in email-style addressing
 *   `=`  reads as assignment and is base64 padding
 *
 * Everything this rejects is still a legal MXID, so a federated user from
 * another homeserver may well have one. This constrains what *this* instance
 * hands out, not what it can talk to.
 */

/**
 * Short enough to be memorable, long enough not to be a landgrab.
 *
 * Two characters would make the namespace small enough to exhaust and would
 * put real weight on names nobody can tell apart. The ceiling matters less;
 * it exists so a name fits in a member list without truncation.
 */
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;

/** Legal characters, after normalisation. */
const ALLOWED_CHARACTERS = /^[a-z0-9._-]+$/;
/** Separators may join parts of a name; they may not lead, trail, or double. */
const SEPARATORS = /[._-]/;

/**
 * Names nobody may register, because holding one is a way to be mistaken for
 * something else.
 *
 * Checked against the *folded* form (see `foldUsername`), so `adm1n` and
 * `s0vrgn` are refused along with `admin` and `sovrgn`. A blocklist compared
 * against raw input only stops people who aren't trying.
 *
 * This is impersonation defence, not trademark protection. The test for
 * membership is roughly: if an account with this name said "your account has
 * a problem, send me your recovery key," would the name itself lend that
 * weight?
 */
const RESERVED_WORDS = [
  // Authority within an instance.
  "admin",
  "administrator",
  "root",
  "superuser",
  "system",
  "staff",
  "moderator",
  "mod",
  "owner",
  "operator",
  "security",
  "support",
  "help",
  "helpdesk",
  "official",
  "bot",
  // The project and its publisher.
  "sovrgn",
  "sovrgnnet",
  "formicaria",
  // Protocol and routing words that appear in paths and identifiers.
  "matrix",
  "api",
  "server",
  "homeserver",
  "instance",
  "wellknown",
  // Mention keywords. An account named `everyone` makes every mention of it
  // ambiguous with the broadcast it looks like.
  "everyone",
  "here",
  "all",
  "channel",
  "room",
  // Words a UI uses to mean the reader, or to mean nothing.
  "me",
  "self",
  "you",
  "anonymous",
  "guest",
  "deleted",
  "unknown",
  "none",
  "nobody",
  "null",
  "undefined",
] as const;

/**
 * The blocklist as it is actually compared: folded, once, at load.
 *
 * The list above is written the way a person reads it, and the lookup happens
 * on folded input, so the two have to be brought into the same form. Doing it
 * here rather than in the list keeps the list editable by anyone without them
 * needing to know what `adm1n` is for — and the first version of this file
 * skipped the step entirely, which left every entry unreachable and the whole
 * blocklist quietly inert.
 */
const RESERVED_FOLDED: ReadonlySet<string> = new Set(
  RESERVED_WORDS.map(foldUsername)
);

/**
 * The prefix every pre-username account already occupies.
 *
 * Accounts created before usernames existed got the Matrix localpart
 * `sovrgn_<database id>`. Those MXIDs are permanent — Matrix has no rename —
 * so the localpart `sovrgn_7` belongs to whoever was user 7 forever.
 *
 * If someone could register the username `sovrgn_7`, their derived localpart
 * would be that same MXID: either registration fails confusingly, or two
 * accounts claim one identity. Reserving the whole prefix closes it without
 * needing to know which ids were ever issued.
 */
const LEGACY_LOCALPART_PREFIX = "sovrgn_";

export type UsernameProblem =
  | "empty"
  | "too-short"
  | "too-long"
  | "bad-characters"
  | "bad-start"
  | "bad-end"
  | "doubled-separator"
  | "reserved";

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; problem: UsernameProblem; message: string };

/**
 * The form a username is stored and compared in.
 *
 * Case only: trims surrounding whitespace and lowercases. Matrix localparts
 * are case-sensitive in principle but the specification tells clients to use
 * lowercase, and a namespace where `Alice` and `alice` are different people is
 * an impersonation vector with no upside.
 */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * The uniqueness key — *not* the stored name.
 *
 * Two usernames that fold to the same string may not both exist. This is
 * deliberately stricter than equality, because the point is what a person
 * skim-reading a member list can tell apart, not what a string comparison can.
 *
 * It removes separators and maps the letter/digit pairs that are unreliable at
 * UI sizes in most sans-serif faces:
 *
 *   `alice.hart` `alice_hart` `alice-hart` `alicehart`   → one name
 *   `bob` `b0b`                                           → one name
 *   `lena` `1ena`                                         → one name
 *
 * The cost is real and worth stating: whoever registers `alice-hart` also
 * takes `alicehart`, and someone whose actual name folds onto a taken one is
 * simply told it's unavailable. That is the trade — a smaller namespace in
 * exchange for names that can't be counterfeited by substitution.
 *
 * Restricting the charset to ASCII is what makes this tractable at all. The
 * general form of this problem is Unicode confusables, which needs a table and
 * a policy; there is no Cyrillic `а` to worry about here because there is no
 * Cyrillic.
 */
export function foldUsername(input: string): string {
  return normalizeUsername(input)
    .replace(/[._-]/g, "")
    .replace(/[o]/g, "0")
    .replace(/[il]/g, "1");
}

/**
 * Whether a string can be used as a Matrix localpart at all.
 *
 * Deliberately weaker than `checkUsername`, and the difference matters. That
 * function enforces *policy* — reserved words, minimum length, no doubled
 * separators — and policy is allowed to tighten later. This one enforces the
 * part that can never change: the character set and the length ceiling that
 * make a legal identifier.
 *
 * The distinction exists because a Matrix ID is permanent. If a future release
 * adds a word to the blocklist, the accounts that already hold it must keep
 * working; running the full policy check on every login would lock them out of
 * an identity they can't change. So the permanent gate checks the permanent
 * property, and nothing more.
 */
export function isLegalLocalpart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= USERNAME_MAX_LENGTH &&
    ALLOWED_CHARACTERS.test(value)
  );
}

/** Whether a name is one this instance refuses to hand out. */
export function isReservedUsername(input: string): boolean {
  const normalized = normalizeUsername(input);
  if (normalized.startsWith(LEGACY_LOCALPART_PREFIX)) return true;
  return RESERVED_FOLDED.has(foldUsername(normalized));
}

/**
 * The single answer to "may this person have this name".
 *
 * Returns the normalised username on success so callers store what was
 * checked rather than what was typed — the gap between those two is where
 * case-sensitivity bugs live.
 *
 * Order is chosen for the message it produces: length before charset, so
 * pasting an essay says it's too long rather than listing every illegal
 * character in it.
 */
export function checkUsername(input: string): UsernameCheck {
  const username = normalizeUsername(input);

  if (username.length === 0) {
    return { ok: false, problem: "empty", message: "Pick a username." };
  }
  if (username.length < USERNAME_MIN_LENGTH) {
    return {
      ok: false,
      problem: "too-short",
      message: `Usernames are at least ${USERNAME_MIN_LENGTH} characters.`,
    };
  }
  if (username.length > USERNAME_MAX_LENGTH) {
    return {
      ok: false,
      problem: "too-long",
      message: `Usernames are at most ${USERNAME_MAX_LENGTH} characters.`,
    };
  }
  if (!ALLOWED_CHARACTERS.test(username)) {
    return {
      ok: false,
      problem: "bad-characters",
      message: "Usernames use letters, numbers, dots, dashes and underscores.",
    };
  }
  // Leading digits are legal in Matrix and rejected here: a name that starts
  // with one reads as an id rather than a person, and `7` alongside the
  // legacy `sovrgn_7` scheme invites exactly the wrong guess about who it is.
  if (!/^[a-z]/.test(username)) {
    return {
      ok: false,
      problem: "bad-start",
      message: "Usernames start with a letter.",
    };
  }
  if (SEPARATORS.test(username[username.length - 1])) {
    return {
      ok: false,
      problem: "bad-end",
      message: "Usernames end with a letter or number.",
    };
  }
  if (/[._-]{2}/.test(username)) {
    return {
      ok: false,
      problem: "doubled-separator",
      message: "Usernames don't repeat dots, dashes or underscores.",
    };
  }
  if (isReservedUsername(username)) {
    return {
      ok: false,
      problem: "reserved",
      message: "That username is reserved.",
    };
  }

  return { ok: true, username };
}

/** Convenience for callers that only need a yes or no. */
export function isValidUsername(input: string): boolean {
  return checkUsername(input).ok;
}

/**
 * Whether the resulting Matrix ID fits in the 255 bytes the specification
 * allows for one.
 *
 * `USERNAME_MAX_LENGTH` alone can't guarantee this: the MXID is
 * `@<localpart>:<server name>`, so a long enough server name overflows it
 * regardless of the username. At 32 characters this leaves 221 for the server
 * name, which no real domain approaches — but an instance is free to set an
 * absurd `MATRIX_SERVER_NAME`, and finding that out at registration time is
 * better than minting an MXID other homeservers will reject.
 */
export function mxidFits(username: string, serverName: string): boolean {
  // `@` + localpart + `:` + server name, counted in bytes rather than UTF-16
  // code units, because the limit is on the wire format.
  const bytes = new TextEncoder().encode(`@${username}:${serverName}`).length;
  return bytes <= 255;
}

// ------------------------------------------------------------------- renaming

export type RenameConsequence = {
  /** One line, in plain language. No jargon in this field. */
  headline: string;
  /** Why, for someone who wants to know. */
  detail: string;
};

/**
 * What actually happens when someone changes their username.
 *
 * This exists as data rather than as copy inside a component because it is the
 * substance of task #33, not decoration around it. The server returns it, the
 * confirmation dialog renders it, and a test asserts the Matrix ID is named —
 * so the warning cannot quietly drift out of the UI while the behaviour stays.
 *
 * ## The thing being disclosed
 *
 * Matrix has no rename. A localpart is fixed at registration, permanently. So
 * changing a username here changes what this instance calls you and *nothing*
 * on the homeserver: the account stays `@old:server` for the rest of its life.
 *
 * The alternative — registering a fresh Matrix account on rename — was
 * considered and rejected in ADR 0012. It costs more and delivers less: you
 * would have to be re-invited to every room, power levels are per-MXID so
 * moderators would silently lose their roles, encrypted history would be
 * unreadable without an explicit key export and import, and every message
 * already sent would *still* show the old ID. Two identities instead of one,
 * for a cosmetic improvement to future messages only.
 *
 * Nobody can be given an honest choice here without being told this, and the
 * temptation is to phrase it as though it barely matters. It does matter, so
 * `headline` says the plain thing first.
 */
export function renameConsequences(input: {
  currentMatrixId: string | null;
  newUsername: string;
}): RenameConsequence[] {
  const consequences: RenameConsequence[] = [
    {
      headline: `People here will see you as ${input.newUsername}.`,
      detail:
        "Your profile, mentions and search all use the new name straight away, " +
        "on this server.",
    },
  ];

  // Null before the Matrix account is provisioned — a brand new account that
  // has never opened a chat. There is no permanent ID to warn about yet, and
  // inventing one to display would be a lie in the other direction.
  if (input.currentMatrixId) {
    consequences.push(
      {
        headline: `Your Matrix address stays ${input.currentMatrixId}.`,
        detail:
          "Matrix has no way to rename an account, so this one keeps the address " +
          "it was created with. Anyone on another server still reaches you at it, " +
          "and it is what they will see.",
      },
      {
        headline: "Messages you have already sent keep the old name.",
        detail:
          "They are stored on every server that received them, attributed to the " +
          "old address. Nothing here can reach back and change that.",
      }
    );
  }

  consequences.push({
    headline: "You sign in with the new name from now on.",
    detail:
      "The old one is released and someone else can take it, so a link or an " +
      "invitation that used it will point at whoever does.",
  });

  return consequences;
}
