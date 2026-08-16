/**
 * The .sovbackup format.
 *
 * A backup that only restores onto the machine it came from isn't portable, and
 * an operator who can't move hosts isn't sovereign — they've just picked a host
 * they can't leave. So this format is designed for the migration case first:
 * take an archive off one machine, validate it against a different one, and
 * know *before* writing anything whether the restore will produce a working
 * instance or a broken one.
 *
 * The old backup was a tarball of a directory plus a prose README. Fine for
 * restoring in place, useless for deciding whether a restore is safe. This adds
 * a manifest so that decision is mechanical.
 *
 * Design rules:
 *   - Validate before writing. A half-applied restore is worse than a refused
 *     one, because it looks like it worked.
 *   - Fatal vs warning is a real distinction, not severity flavour. Fatal means
 *     "this restore produces a broken instance". Warning means "you'll lose
 *     something, proceed if you meant to".
 *   - Unknown fields survive a round trip. A backup taken by a newer version
 *     should not be silently stripped by an older one.
 */

import { z } from "zod";
import { PROTOCOL_VERSION, protocolVersionSchema } from "./protocol";

/** Bumped only for changes that older readers cannot handle. */
export const BACKUP_FORMAT_VERSION = 1;

export const BACKUP_FORMAT = "sovbackup" as const;

export const BACKUP_EXTENSION = ".sovbackup" as const;

export const MANIFEST_FILENAME = "manifest.json" as const;

/**
 * Components, and whether the instance is still an instance without them.
 *
 * `database` is required because it *is* the instance: accounts, communities,
 * membership, roles. `matrixKey` is not required — a restore without it works,
 * it just becomes a different server to anyone it has federated with, which is
 * a loss worth warning loudly about rather than refusing.
 */
export const COMPONENTS = {
  database: {
    file: "database.sql",
    required: true,
    describe: "accounts, communities, channels, messages",
    ifMissing: "The instance cannot be restored without it.",
  },
  homeserver: {
    file: "dendrite.sql",
    required: false,
    describe: "the homeserver's rooms and events",
    ifMissing: "Chat history will be empty; structure survives.",
  },
  matrixKey: {
    file: "matrix_key.pem",
    required: false,
    describe: "the homeserver's signing key — its identity on the Matrix network",
    ifMissing:
      "The restored instance becomes a different server to anyone it has federated with.",
  },
  files: {
    file: "ipfs_data.tar.gz",
    required: false,
    describe: "the bytes of every shared file",
    ifMissing: "File records survive; the files themselves will not download.",
  },
  settings: {
    file: "env.backup",
    required: false,
    describe: "secrets and configuration",
    ifMissing: "You will need to supply secrets again by hand.",
  },
} as const;

export type ComponentName = keyof typeof COMPONENTS;

export const componentNames = Object.keys(COMPONENTS) as ComponentName[];

export const componentSchema = z.object({
  name: z.string(),
  file: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a hex sha256"),
});

export type BackupComponent = z.infer<typeof componentSchema>;

export const manifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    formatVersion: z.number().int().positive(),
    createdAt: z.string(),

    instance: z.object({
      /** Derived from the Matrix server name — see server/instance.ts. */
      id: z.string(),
      matrixServerName: z.string(),
      name: z.string().nullable().default(null),
    }),

    versions: z.object({
      app: z.string(),
      protocol: protocolVersionSchema,
      /** Latest applied drizzle migration tag, e.g. "0005_fuzzy_kylun". */
      schema: z.string().nullable().default(null),
    }),

    runtime: z.enum(["docker", "native", "unknown"]).default("unknown"),

    components: z.array(componentSchema).default([]),
  })
  // Unknown keys pass through: a backup written by a newer version must not be
  // quietly stripped of fields this version doesn't understand.
  .passthrough();

export type BackupManifest = z.infer<typeof manifestSchema>;

export function parseManifest(raw: unknown): BackupManifest | null {
  const parsed = manifestSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// -- Validation ---------------------------------------------------------------

export type Severity = "fatal" | "warning";

export interface Problem {
  severity: Severity;
  code: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: Problem[];
}

/** The machine being restored onto. Every field optional — a fresh install
 *  knows none of it, and that's the easy case, not an error. */
export interface RestoreTarget {
  appVersion?: string;
  matrixServerName?: string;
  /** Migration tags this build ships, oldest first. */
  knownSchemas?: string[];
}

/** Files actually present in the archive, with their real hashes. */
export interface ArchiveContents {
  files: Array<{ file: string; bytes: number; sha256: string }>;
}

/**
 * Decide whether this backup can be restored onto this target.
 *
 * Deliberately pure: no filesystem, no database. The caller hashes the files
 * and reads the target, this decides. That makes the rules testable, which is
 * the only way anyone should trust a restore path.
 */
export function validateRestore(
  manifest: BackupManifest,
  archive: ArchiveContents,
  target: RestoreTarget = {}
): ValidationResult {
  const problems: Problem[] = [];

  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    problems.push({
      severity: "fatal",
      code: "format-too-new",
      message:
        `This backup uses format version ${manifest.formatVersion}; this build understands ` +
        `up to ${BACKUP_FORMAT_VERSION}. Update SOVRGNnet, then restore.`,
    });
  }

  // The one that matters most. Matrix user and room IDs embed the server name
  // permanently at creation. Restore a backup from "a.example" onto an instance
  // calling itself "b.example" and every ID inside points at a server this one
  // isn't — history detaches, and it detaches silently.
  if (
    target.matrixServerName &&
    target.matrixServerName !== manifest.instance.matrixServerName
  ) {
    problems.push({
      severity: "fatal",
      code: "server-name-mismatch",
      message:
        `This backup is from "${manifest.instance.matrixServerName}" but this instance is ` +
        `"${target.matrixServerName}". Matrix IDs embed the server name permanently, so ` +
        `restoring would detach every room and user from their history. Set ` +
        `MATRIX_SERVER_NAME to "${manifest.instance.matrixServerName}" and try again.`,
    });
  }

  // Schema newer than this build can't be walked backwards — migrations only
  // go forward. Older is fine: they run at boot.
  if (manifest.versions.schema && target.knownSchemas?.length) {
    if (!target.knownSchemas.includes(manifest.versions.schema)) {
      problems.push({
        severity: "fatal",
        code: "schema-unknown",
        message:
          `The backup was taken at schema "${manifest.versions.schema}", which this build ` +
          `doesn't know. It was probably taken by a newer version — update SOVRGNnet first. ` +
          `Migrations only run forward.`,
      });
    } else if (
      target.knownSchemas.indexOf(manifest.versions.schema) <
      target.knownSchemas.length - 1
    ) {
      problems.push({
        severity: "warning",
        code: "schema-older",
        message:
          `The backup is at schema "${manifest.versions.schema}"; this build is newer. ` +
          `Pending migrations will be applied automatically at startup.`,
      });
    }
  }

  if (manifest.versions.protocol.major !== PROTOCOL_VERSION.major) {
    problems.push({
      severity: "warning",
      code: "protocol-major-differs",
      message:
        `The backup speaks protocol ${manifest.versions.protocol.major}.` +
        `${manifest.versions.protocol.minor}; this build speaks ` +
        `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}. Connected clients may need updating.`,
    });
  }

  const present = new Map(archive.files.map(f => [f.file, f]));

  for (const declared of manifest.components) {
    const actual = present.get(declared.file);

    if (!actual) {
      const known = componentNames.find(n => COMPONENTS[n].file === declared.file);
      const required = known ? COMPONENTS[known].required : false;
      problems.push({
        severity: required ? "fatal" : "warning",
        code: "component-missing",
        message:
          `"${declared.file}" is listed in the manifest but missing from the archive.` +
          (known ? ` ${COMPONENTS[known].ifMissing}` : ""),
      });
      continue;
    }

    // Corruption is always fatal, whatever the component. Restoring a truncated
    // database dump is how you get an instance that starts and is subtly wrong.
    if (actual.sha256 !== declared.sha256) {
      problems.push({
        severity: "fatal",
        code: "checksum-mismatch",
        message:
          `"${declared.file}" doesn't match its checksum — the archive is corrupt or was ` +
          `modified. Restoring it could leave the instance in an inconsistent state.`,
      });
    } else if (actual.bytes !== declared.bytes) {
      problems.push({
        severity: "warning",
        code: "size-mismatch",
        message: `"${declared.file}" is ${actual.bytes} bytes; the manifest says ${declared.bytes}.`,
      });
    }
  }

  for (const name of componentNames) {
    const spec = COMPONENTS[name];
    const declared = manifest.components.some(c => c.file === spec.file);
    if (declared) continue;

    problems.push({
      severity: spec.required ? "fatal" : "warning",
      code: "component-absent",
      message: `No ${spec.describe} in this backup. ${spec.ifMissing}`,
    });
  }

  return { ok: !problems.some(p => p.severity === "fatal"), problems };
}

/** Human-readable summary. Used by the CLI, so it has to read well to someone
 *  who has just had a machine die and is not in the mood for a stack trace. */
export function describeValidation(result: ValidationResult): string {
  if (result.problems.length === 0) return "Backup verified. Safe to restore.";

  const fatal = result.problems.filter(p => p.severity === "fatal");
  const warnings = result.problems.filter(p => p.severity === "warning");

  const lines: string[] = [];

  if (fatal.length > 0) {
    lines.push("Cannot restore this backup:");
    for (const p of fatal) lines.push(`  ✗ ${p.message}`);
    if (warnings.length > 0) lines.push("");
  }

  if (warnings.length > 0) {
    lines.push(fatal.length > 0 ? "Also worth knowing:" : "Restore will proceed, but:");
    for (const p of warnings) lines.push(`  ! ${p.message}`);
  }

  if (fatal.length === 0) {
    lines.push("");
    lines.push("Nothing here blocks the restore.");
  }

  return lines.join("\n");
}

/** Filename for a new backup. Sorts chronologically as plain text, which is
 *  what someone staring at a directory of them actually needs. */
export function backupFilename(instanceId: string, when = new Date()): string {
  const stamp = when.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "_");
  return `sovrgnnet_${instanceId}_${stamp}${BACKUP_EXTENSION}`;
}
