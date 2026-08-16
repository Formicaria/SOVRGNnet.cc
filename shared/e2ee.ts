/**
 * The parts of end-to-end encryption that are decisions rather than cryptography
 * — ADR 0008 stage 4, ADR 0011.
 *
 * Everything here is pure and dependency-free, for the same reason
 * `protocol.ts` is: it runs in the browser, in the desktop shell, in the
 * server, and in tests that have no WASM and no homeserver. The cryptography
 * itself lives in matrix-js-sdk and is not reimplemented anywhere in this
 * repository. What lives here is the surrounding judgement — which room state
 * we write, what a decryption failure *means*, and when the instance is
 * allowed to claim `e2ee` — because those are the parts that can be wrong in
 * ways cryptography can't catch, and the parts worth testing.
 */

/** The only room encryption algorithm this project implements or accepts. */
export const MEGOLM_ALGORITHM = "m.megolm.v1.aes-sha2";

export const ENCRYPTION_STATE_EVENT = "m.room.encryption";
export const ENCRYPTED_EVENT_TYPE = "m.room.encrypted";

/**
 * The `m.room.encryption` content written when a room is switched on.
 *
 * Rotation is deliberately more aggressive than the spec's example values
 * (a week / 100 messages). A Megolm session is the unit of compromise: every
 * message sent under one session is readable by anyone who obtains that
 * session's key, so a longer-lived session widens the blast radius of a single
 * leaked key. A day and 100 messages costs a few extra key shares per room per
 * day, which is not a cost anyone will notice.
 */
export function encryptionStateContent(): {
  algorithm: string;
  rotation_period_ms: number;
  rotation_period_msgs: number;
} {
  return {
    algorithm: MEGOLM_ALGORITHM,
    rotation_period_ms: 24 * 60 * 60 * 1000,
    rotation_period_msgs: 100,
  };
}

/**
 * Is this `m.room.encryption` content something we can actually read?
 *
 * A room encrypted with an algorithm we don't implement is not "encrypted, fine"
 * — it is a room where every message is permanently unreadable to this client.
 * Treating an unknown algorithm as ordinary encryption would show users a lock
 * icon over messages that will never decrypt.
 */
export function isSupportedEncryption(content: unknown): boolean {
  if (!content || typeof content !== "object") return false;
  return (content as { algorithm?: unknown }).algorithm === MEGOLM_ALGORITHM;
}

/**
 * What the reader can be told about one message.
 *
 * "Encrypted" is not a display state. A message that decrypted fine and a
 * message whose key never arrived are both `m.room.encrypted` on the wire and
 * must never look the same in the UI — one is readable and one is a hole in
 * the conversation, and only the second is something the user might act on.
 */
export type MessageCryptoState =
  /** Not encrypted. Nothing to say about it. */
  | "plaintext"
  /** Encrypted and successfully decrypted by this device. */
  | "decrypted"
  /** Encrypted; the key may still arrive. Transient, usually seconds. */
  | "pending"
  /** Encrypted; the key will not arrive without action from the user. */
  | "recoverable"
  /** Encrypted; nothing will make this readable on this device. */
  | "lost";

export interface DecryptionVerdict {
  state: MessageCryptoState;
  /** One sentence, addressed to the reader, in plain language. */
  detail: string;
}

/**
 * Turn a decryption failure code into something honest.
 *
 * The codes are matrix-js-sdk's `DecryptionFailureCode`, passed as strings so
 * this module keeps no dependency on the SDK — and so the mapping can be
 * tested without loading WASM. Anything unrecognised is reported as lost
 * rather than pending: telling someone a message is "still arriving" when we
 * have no idea why it failed is a message that spins forever.
 */
export function describeDecryptionFailure(
  code: string | null | undefined
): DecryptionVerdict {
  switch (code) {
    case null:
    case undefined:
    case "":
      return { state: "decrypted", detail: "" };

    case "MEGOLM_UNKNOWN_INBOUND_SESSION_ID":
      return {
        state: "pending",
        detail: "Waiting for the key to this message.",
      };

    case "OLM_UNKNOWN_MESSAGE_INDEX":
      return {
        state: "pending",
        detail:
          "This device joined the conversation after this message was sent.",
      };

    case "MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE":
      return {
        state: "recoverable",
        detail:
          "The sender didn't share the key because this device isn't verified. Verify it to read this.",
      };

    case "MEGOLM_KEY_WITHHELD":
      return {
        state: "lost",
        detail: "The sender chose not to share the key to this message.",
      };

    case "HISTORICAL_MESSAGE_BACKUP_UNCONFIGURED":
      return {
        state: "recoverable",
        detail:
          "Sent before this device existed. Enter your recovery key to restore older messages.",
      };

    case "HISTORICAL_MESSAGE_WORKING_BACKUP":
      return {
        state: "pending",
        detail:
          "Sent before this device existed. Restoring it from your key backup.",
      };

    case "HISTORICAL_MESSAGE_NO_KEY_BACKUP":
      return {
        state: "lost",
        detail:
          "Sent before this device existed, and there is no key backup to restore it from.",
      };

    case "HISTORICAL_MESSAGE_USER_NOT_JOINED":
      return {
        state: "lost",
        detail: "Sent before you joined this channel.",
      };

    case "SENDER_IDENTITY_PREVIOUSLY_VERIFIED":
      return {
        state: "recoverable",
        detail:
          "The sender's identity changed since you verified them. Verify them again to read this.",
      };

    case "UNSIGNED_SENDER_DEVICE":
      return {
        state: "recoverable",
        detail: "Sent from a device its owner has never verified.",
      };

    default:
      return {
        state: "lost",
        detail: "This message can't be decrypted on this device.",
      };
  }
}

/**
 * Everything the client knows about its own crypto setup.
 *
 * Deliberately four independent booleans rather than one "is E2EE working"
 * flag. They fail separately and they are fixed separately, and collapsing
 * them would mean showing a user "encryption is broken" when what is actually
 * true is "your key backup is off".
 */
export interface CryptoReadiness {
  /** Cross-signing keys exist and this device is signed by them. */
  crossSigningReady: boolean;
  /** A recovery key exists and secret storage holds the cross-signing secrets. */
  secretStorageReady: boolean;
  /** Room keys are being uploaded to a server-side backup as they're created. */
  keyBackupEnabled: boolean;
  /** This device is verified — by another device, or by being the first one. */
  deviceVerified: boolean;
}

export type ReadinessLevel = "ready" | "incomplete" | "unset";

export interface ReadinessVerdict {
  level: ReadinessLevel;
  /** The single most useful thing the user could do next, or null when done. */
  nextStep: string | null;
  headline: string;
}

/**
 * The one honest sentence about this device's encryption setup.
 *
 * The ordering of the checks is the ordering of the fixes: there is no point
 * telling someone their key backup is off if they have not set up cross-signing,
 * because setting up cross-signing is what creates the backup.
 */
export function describeReadiness(state: CryptoReadiness): ReadinessVerdict {
  if (!state.crossSigningReady) {
    return {
      level: "unset",
      headline: "Encryption isn't set up on this account yet.",
      nextStep:
        "Set up encryption to get a recovery key and let your other devices trust this one.",
    };
  }

  if (!state.deviceVerified) {
    return {
      level: "incomplete",
      headline: "This device isn't verified.",
      nextStep:
        "Verify it from a device you already use, or with your recovery key. Until you do, others may not send it keys.",
    };
  }

  if (!state.secretStorageReady) {
    return {
      level: "incomplete",
      headline: "Your account has no recovery key.",
      nextStep:
        "Create one. Without it, losing every signed-in device loses every encrypted message.",
    };
  }

  if (!state.keyBackupEnabled) {
    return {
      level: "incomplete",
      headline: "Key backup is off.",
      nextStep:
        "Turn it on. Messages sent while it's off can't be read on a new device later.",
    };
  }

  return {
    level: "ready",
    headline: "Encryption is set up and your keys are backed up.",
    nextStep: null,
  };
}

/**
 * Whether an instance may advertise the `e2ee` capability.
 *
 * The point of deriving it is that the same mistake has now been made twice in
 * this codebase — `encryption` in v0.3 and `clientMatrix` before stage 2 both
 * turned a deployment detail into a claim — and both times a client acted on
 * the claim. So: three things must be true at once, and an operator can't set
 * any of them with an environment variable.
 *
 * - The build ships a crypto implementation at all.
 * - A homeserver actually answered at the advertised address, so the client
 *   can hold its own session and therefore its own keys. On a loopback-only
 *   deployment there is nowhere for keys to live except the server, which is
 *   the arrangement E2EE exists to end.
 * - The instance records events its homeserver pushes, so an encrypted message
 *   is in the index for every member — including ones whose client is on the
 *   API fallback and will only ever see that it exists.
 */
export function deriveE2eeCapability(input: {
  implemented: boolean;
  homeserverReachable: boolean;
  eventIngest: boolean;
}): boolean {
  return input.implemented && input.homeserverReachable && input.eventIngest;
}

/**
 * Base58, as Matrix encodes recovery keys.
 * https://spec.matrix.org/v1.11/client-server-api/#key-representation
 */
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Clean up a recovery key the user typed or pasted.
 *
 * Displayed in groups of four, so it comes back with spaces in it, and often
 * with a newline from a password manager. Stripping all whitespace is not
 * lenience — the grouping is a display convention and was never part of the
 * key.
 */
export function normaliseRecoveryKey(input: string): string {
  return input.replace(/\s+/g, "");
}

/**
 * Does this look like a recovery key at all?
 *
 * A shape check, not a validity check — only the crypto layer can say whether
 * a well-formed key is the *right* key. It exists so that a typo gets "that
 * isn't a recovery key" immediately instead of a decryption error thirty
 * seconds later.
 */
export function looksLikeRecoveryKey(input: string): boolean {
  const key = normaliseRecoveryKey(input);
  // 32 bytes of key plus prefix and parity, base58-encoded, lands at 58–59
  // characters. The range is deliberately loose: this rejects typos and
  // pasted paragraphs, and leaves judgement to the decoder.
  return key.length >= 44 && key.length <= 64 && BASE58.test(key);
}

/** Display grouping for a freshly generated key. Four-character groups. */
export function formatRecoveryKey(key: string): string {
  return normaliseRecoveryKey(key)
    .replace(/(.{4})/g, "$1 ")
    .trim();
}
