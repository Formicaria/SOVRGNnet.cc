import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

/**
 * Encryption at rest for `.sovbackup` archives.
 *
 * A backup is the whole instance in one file: every account, every message,
 * every uploaded byte. Unencrypted, its safety is exactly the safety of
 * wherever it happens to be copied — the second box, the USB stick, the
 * object-storage bucket. This envelope makes the file itself carry the
 * protection instead.
 *
 * Layered *around* the archive, not into it: the plaintext inside is a
 * byte-for-byte ordinary `.sovbackup`, so every existing validation and
 * restore path works unchanged once the envelope is opened. Decrypt-then-
 * restore equals restore.
 *
 * Choices, and why:
 * - **scrypt** (N=2^15, r=8, p=1, 32 MiB) for the passphrase → key
 *   derivation. Backups are opened rarely and by humans; a KDF that costs a
 *   third of a second is free here and expensive for a brute force.
 * - **AES-256-GCM** for the payload: authenticated, so a flipped bit or a
 *   truncated file fails loudly at open rather than quietly at restore.
 * - **The magic string is authenticated** as additional data, so a valid
 *   ciphertext cannot be replayed under a different future envelope version.
 * - No compression decisions here — the archive is already gzipped.
 */

export const ENVELOPE_MAGIC = Buffer.from("SOVBAKENC1");

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class BackupCryptoError extends Error {
  constructor(
    message: string,
    /** Wrong passphrase and corrupt file are the same to GCM; callers that
     * want to phrase advice can look here. */
    public readonly reason: "not-encrypted" | "bad-passphrase-or-corrupt" | "bad-input"
  ) {
    super(message);
    this.name = "BackupCryptoError";
  }
}

/** Cheap header check — reads ten bytes, not the file. */
export function isEncryptedBackup(data: Buffer): boolean {
  return (
    data.length >= ENVELOPE_MAGIC.length &&
    timingSafeEqual(data.subarray(0, ENVELOPE_MAGIC.length), ENVELOPE_MAGIC)
  );
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, SCRYPT);
}

export function encryptBackup(archive: Buffer, passphrase: string): Buffer {
  if (!passphrase || passphrase.length < 8) {
    throw new BackupCryptoError(
      "A backup passphrase must be at least 8 characters.",
      "bad-input"
    );
  }
  if (isEncryptedBackup(archive)) {
    // Double-encrypting is always a mistake: the second passphrase hides the
    // first prompt, and restores fail one layer in with a confusing error.
    throw new BackupCryptoError("This file is already encrypted.", "bad-input");
  }

  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(ENVELOPE_MAGIC);
  const ciphertext = Buffer.concat([cipher.update(archive), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([ENVELOPE_MAGIC, salt, iv, tag, ciphertext]);
}

export function decryptBackup(envelope: Buffer, passphrase: string): Buffer {
  if (!isEncryptedBackup(envelope)) {
    throw new BackupCryptoError(
      "This file is not an encrypted backup.",
      "not-encrypted"
    );
  }
  const minimum = ENVELOPE_MAGIC.length + SALT_LENGTH + IV_LENGTH + TAG_LENGTH;
  if (envelope.length <= minimum) {
    throw new BackupCryptoError("The encrypted file is truncated.", "bad-input");
  }

  let offset = ENVELOPE_MAGIC.length;
  const salt = envelope.subarray(offset, (offset += SALT_LENGTH));
  const iv = envelope.subarray(offset, (offset += IV_LENGTH));
  const tag = envelope.subarray(offset, (offset += TAG_LENGTH));
  const ciphertext = envelope.subarray(offset);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(ENVELOPE_MAGIC);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupCryptoError(
      "Wrong passphrase, or the file has been modified. GCM cannot tell these apart — both mean the bytes in front of you will not produce the backup that was written.",
      "bad-passphrase-or-corrupt"
    );
  }
}
