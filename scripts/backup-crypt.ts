/**
 * The shell scripts' door into shared/backupCrypto.ts.
 *
 *   tsx scripts/backup-crypt.ts encrypt <in> <out>
 *   tsx scripts/backup-crypt.ts decrypt <in> <out>
 *   tsx scripts/backup-crypt.ts check   <in>          exits 0 if encrypted
 *
 * The passphrase comes from SOVRGN_BACKUP_PASSPHRASE — the environment, never
 * argv, because argv is visible to every process on the machine via ps.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  BackupCryptoError,
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
} from "../shared/backupCrypto";

const [, , command, input, output] = process.argv;

function fail(message: string): never {
  console.error(`backup-crypt: ${message}`);
  process.exit(1);
}

if (!command || !input) {
  fail("usage: backup-crypt.ts <encrypt|decrypt|check> <in> [out]");
}

const data = readFileSync(input);

if (command === "check") {
  process.exit(isEncryptedBackup(data) ? 0 : 1);
}

if (!output) fail("an output path is required");
const passphrase = process.env.SOVRGN_BACKUP_PASSPHRASE ?? "";
if (!passphrase) fail("SOVRGN_BACKUP_PASSPHRASE is not set");

try {
  if (command === "encrypt") {
    writeFileSync(output, encryptBackup(data, passphrase));
  } else if (command === "decrypt") {
    writeFileSync(output, decryptBackup(data, passphrase));
  } else {
    fail(`unknown command: ${command}`);
  }
} catch (err) {
  if (err instanceof BackupCryptoError) fail(err.message);
  throw err;
}
