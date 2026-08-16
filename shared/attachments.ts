/**
 * Encrypted attachments — ADR 0011.
 *
 * When every channel on a capable instance is encrypted, a file upload that
 * puts readable bytes on the instance's IPFS node is a hole in every channel
 * at once, under a lock icon. Messages became ciphertext and files stayed
 * plaintext would be exactly the kind of half-claim this project keeps
 * auditing itself for.
 *
 * This is not new cryptography. It is Matrix's `EncryptedFile` format, which
 * is AES-CTR-256 with the key travelling inside the event — and since the
 * event is Megolm-encrypted, the key reaches exactly the devices the message
 * reaches and nothing else. Implemented against WebCrypto, which both the
 * browser and Node 22 provide, so the same code runs in the client and in the
 * tests.
 *
 * What this protects and what it doesn't:
 *
 * - **Bytes**: encrypted before they leave the device. The instance stores
 *   ciphertext and pins ciphertext to IPFS.
 * - **Filename, size and MIME type**: not protected. They are columns in the
 *   `fileShares` index, which is how the file list works at all, and moving
 *   them into the timeline is a larger change than this one. The threat model
 *   already concedes metadata; this is part of that concession and is named
 *   as such rather than left to be discovered.
 *
 * https://spec.matrix.org/v1.11/client-server-api/#sending-encrypted-attachments
 */

/** The JWK shape the spec requires, exactly. */
export interface AttachmentKey {
  kty: "oct";
  key_ops: string[];
  alg: "A256CTR";
  k: string;
  ext: true;
}

/** What travels in the (encrypted) event alongside the CID. */
export interface EncryptedAttachment {
  key: AttachmentKey;
  /** Base64 initialisation vector. */
  iv: string;
  /** Unpadded-base64 SHA-256 of the *ciphertext*. */
  hashes: { sha256: string };
  v: "v2";
}

/** Unpadded URL-safe base64, as the spec uses for the key. */
function toBase64Url(bytes: Uint8Array<ArrayBuffer>): string {
  return toBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  return fromBase64(value.replace(/-/g, "+").replace(/_/g, "/"));
}

/** Standard base64, used for the IV and the hash. */
function toBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = "";
  // Indexed rather than `for…of`: the root tsconfig targets a low ES level and
  // iterating a typed array directly needs downlevelIteration.
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  // btoa exists in browsers and in Node 22.
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The IV is 16 bytes with the **top 8 zeroed**, and that is not decoration.
 *
 * AES-CTR increments the whole 128-bit block as a counter. The spec reserves
 * the low half for the counter and requires the high half to start at zero, so
 * that a file up to 2^64 blocks long can never carry the counter into the
 * nonce and collide with another file encrypted under a different IV. Filling
 * all sixteen bytes randomly would work almost always and fail silently and
 * catastrophically the rest of the time — keystream reuse across two files.
 */
function generateIv(): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(8));
  return iv;
}

function unpaddedBase64(bytes: Uint8Array<ArrayBuffer>): string {
  return toBase64(bytes).replace(/=+$/, "");
}

/**
 * Encrypt file bytes. Returns the ciphertext to upload and the metadata to put
 * in the event — which must only ever go into an encrypted event, or the key
 * travels in the clear beside the file it locks.
 */
export async function encryptAttachment(
  plaintext: Uint8Array<ArrayBuffer>
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; info: EncryptedAttachment }> {
  const keyBytes = new Uint8Array(32);
  crypto.getRandomValues(keyBytes);
  const iv = generateIv();

  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CTR", true, [
    "encrypt",
    "decrypt",
  ]);

  const encrypted = new Uint8Array<ArrayBuffer>(
    await crypto.subtle.encrypt(
      { name: "AES-CTR", counter: iv, length: 64 },
      key,
      plaintext
    )
  );

  const digest = new Uint8Array<ArrayBuffer>(
    await crypto.subtle.digest("SHA-256", encrypted)
  );

  return {
    ciphertext: encrypted,
    info: {
      key: {
        kty: "oct",
        key_ops: ["encrypt", "decrypt"],
        alg: "A256CTR",
        k: toBase64Url(keyBytes),
        ext: true,
      },
      iv: toBase64(iv),
      hashes: { sha256: unpaddedBase64(digest) },
      v: "v2",
    },
  };
}

export class AttachmentError extends Error {}

/**
 * Decrypt what came back.
 *
 * The hash is checked **before** decryption and a mismatch refuses rather than
 * returning something. AES-CTR is unauthenticated: flip a bit of ciphertext
 * and you flip the same bit of plaintext, with no error anywhere. Without this
 * check the instance could hand back modified bytes and the client would
 * cheerfully render them — which would make the encryption worse than useless,
 * because it would carry an assurance it hadn't earned.
 */
export async function decryptAttachment(
  ciphertext: Uint8Array<ArrayBuffer>,
  info: EncryptedAttachment
): Promise<Uint8Array<ArrayBuffer>> {
  if (info?.v !== "v2") {
    throw new AttachmentError(
      `Unsupported attachment version: ${String(info?.v)}`
    );
  }
  if (info.key?.alg !== "A256CTR" || info.key?.kty !== "oct") {
    throw new AttachmentError(
      "Attachment key isn't the algorithm this understands."
    );
  }

  const digest = new Uint8Array<ArrayBuffer>(
    await crypto.subtle.digest("SHA-256", ciphertext)
  );
  if (unpaddedBase64(digest) !== info.hashes?.sha256) {
    throw new AttachmentError(
      "This file doesn't match the hash in the message. It has been altered or corrupted."
    );
  }

  const keyBytes = fromBase64Url(info.key.k);
  if (keyBytes.length !== 32) {
    throw new AttachmentError("Attachment key is the wrong length.");
  }
  const iv = fromBase64(info.iv);
  if (iv.length !== 16) {
    throw new AttachmentError("Attachment IV is the wrong length.");
  }

  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-CTR", false, [
    "decrypt",
  ]);

  return new Uint8Array<ArrayBuffer>(
    await crypto.subtle.decrypt(
      { name: "AES-CTR", counter: iv, length: 64 },
      key,
      ciphertext
    )
  );
}

/**
 * The event key the attachment metadata travels under.
 *
 * Namespaced rather than using the spec's `file`, because the bytes are not at
 * an `mxc://` URL — they are in this instance's IPFS behind a membership check,
 * which is the arrangement `cc.sovrgnnet.file` already describes. A third-party
 * Matrix client will show the filename and be unable to fetch it, which is
 * accurate: it can't reach the instance's file route either way.
 */
export const ATTACHMENT_EVENT_KEY = "cc.sovrgnnet.file";

export interface FileEventContent {
  msgtype: "m.file";
  body: string;
  [ATTACHMENT_EVENT_KEY]: {
    cid: string;
    size: number;
    mimeType?: string;
    /** Absent for a file shared into a plaintext channel. */
    encryption?: EncryptedAttachment;
  };
}

/** Read attachment metadata out of a decrypted timeline event, if it's there. */
export function readAttachment(
  content: unknown
): { cid: string; encryption: EncryptedAttachment | null } | null {
  const file = (content as Record<string, unknown> | null)?.[
    ATTACHMENT_EVENT_KEY
  ];
  if (!file || typeof file !== "object") return null;
  const cid = (file as { cid?: unknown }).cid;
  if (typeof cid !== "string" || !cid) return null;
  const encryption = (file as { encryption?: unknown }).encryption;
  return {
    cid,
    encryption:
      encryption && typeof encryption === "object"
        ? (encryption as EncryptedAttachment)
        : null,
  };
}
