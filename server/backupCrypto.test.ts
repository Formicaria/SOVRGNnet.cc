import { describe, expect, it } from "vitest";

import {
  BackupCryptoError,
  decryptBackup,
  encryptBackup,
  ENVELOPE_MAGIC,
  isEncryptedBackup,
} from "@shared/backupCrypto";

const archive = Buffer.from(
  "not really a tarball, but the envelope neither knows nor cares"
);

describe("backup encryption at rest", () => {
  it("round-trips byte-for-byte", () => {
    const envelope = encryptBackup(archive, "correct horse battery staple");
    expect(isEncryptedBackup(envelope)).toBe(true);
    expect(isEncryptedBackup(archive)).toBe(false);

    const opened = decryptBackup(envelope, "correct horse battery staple");
    expect(Buffer.compare(opened, archive)).toBe(0);
  });

  it("two encryptions of the same archive share no bytes beyond the magic", () => {
    const a = encryptBackup(archive, "same passphrase");
    const b = encryptBackup(archive, "same passphrase");
    // Fresh salt and IV every time — identical envelopes would leak that two
    // backups have identical contents.
    expect(a.equals(b)).toBe(false);
    expect(a.subarray(0, ENVELOPE_MAGIC.length).equals(b.subarray(0, ENVELOPE_MAGIC.length))).toBe(true);
  });

  it("refuses the wrong passphrase, and says why it can't say more", () => {
    const envelope = encryptBackup(archive, "the right one");
    try {
      decryptBackup(envelope, "the wrong one");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BackupCryptoError);
      expect((err as BackupCryptoError).reason).toBe("bad-passphrase-or-corrupt");
    }
  });

  it("refuses a tampered envelope", () => {
    const envelope = encryptBackup(archive, "passphrase123");
    // Flip one bit deep in the ciphertext.
    envelope[envelope.length - 3] ^= 0x01;
    expect(() => decryptBackup(envelope, "passphrase123")).toThrowError(
      BackupCryptoError
    );
  });

  it("refuses truncation", () => {
    const envelope = encryptBackup(archive, "passphrase123");
    const truncated = envelope.subarray(0, 20);
    expect(() => decryptBackup(truncated, "passphrase123")).toThrowError(
      BackupCryptoError
    );
  });

  it("refuses weak passphrases and double encryption", () => {
    expect(() => encryptBackup(archive, "short")).toThrowError(BackupCryptoError);
    const envelope = encryptBackup(archive, "passphrase123");
    expect(() => encryptBackup(envelope, "another pass")).toThrowError(
      BackupCryptoError
    );
  });

  it("tells plaintext apart from an envelope without opening either", () => {
    expect(() => decryptBackup(archive, "whatever8")).toThrowError(
      /not an encrypted backup/
    );
  });
});
