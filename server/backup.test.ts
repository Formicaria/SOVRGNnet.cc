import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  backupFilename,
  COMPONENTS,
  describeValidation,
  parseManifest,
  validateRestore,
  type ArchiveContents,
  type BackupManifest,
} from "@shared/backup";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function manifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    format: "sovbackup",
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: "2026-08-15T12:00:00.000Z",
    instance: { id: "abc123", matrixServerName: "a.example", name: "Test" },
    versions: { app: "0.4.0", protocol: { major: 1, minor: 0 }, schema: "0005_fuzzy_kylun" },
    runtime: "docker",
    components: [
      { name: "database", file: "database.sql", bytes: 100, sha256: HASH_A },
      { name: "homeserver", file: "dendrite.sql", bytes: 200, sha256: HASH_B },
      { name: "matrixKey", file: "matrix_key.pem", bytes: 50, sha256: HASH_A },
      { name: "files", file: "ipfs_data.tar.gz", bytes: 300, sha256: HASH_B },
      { name: "settings", file: "env.backup", bytes: 10, sha256: HASH_A },
    ],
    ...overrides,
  } as BackupManifest;
}

function archive(m: BackupManifest): ArchiveContents {
  return { files: m.components.map(c => ({ file: c.file, bytes: c.bytes, sha256: c.sha256 })) };
}

describe("manifest parsing", () => {
  it("accepts a complete manifest", () => {
    expect(parseManifest(manifest())).not.toBeNull();
  });

  it("rejects anything that isn't a sovbackup", () => {
    expect(parseManifest({ ...manifest(), format: "tarball" })).toBeNull();
    expect(parseManifest(null)).toBeNull();
    expect(parseManifest("nope")).toBeNull();
    expect(parseManifest({})).toBeNull();
  });

  it("rejects a checksum that isn't a sha256", () => {
    const m = manifest();
    m.components[0].sha256 = "short";
    expect(parseManifest(m)).toBeNull();
  });

  it("keeps fields written by a newer version", () => {
    const parsed = parseManifest({ ...manifest(), somethingNew: { nested: true } });
    expect((parsed as Record<string, unknown>)?.somethingNew).toEqual({ nested: true });
  });

  it("defaults an unstated runtime rather than failing", () => {
    const { runtime: _drop, ...rest } = manifest();
    expect(parseManifest(rest)?.runtime).toBe("unknown");
  });
});

describe("validateRestore — the happy path", () => {
  it("passes a complete backup onto a fresh machine", () => {
    const m = manifest();
    const result = validateRestore(m, archive(m));
    expect(result.ok).toBe(true);
    expect(result.problems).toHaveLength(0);
    expect(describeValidation(result)).toBe("Backup verified. Safe to restore.");
  });

  it("passes onto a machine with a matching server name", () => {
    const m = manifest();
    const result = validateRestore(m, archive(m), {
      matrixServerName: "a.example",
      knownSchemas: ["0000_a", "0005_fuzzy_kylun"],
    });
    expect(result.ok).toBe(true);
  });
});

describe("validateRestore — server name", () => {
  it("refuses a restore onto a different server name", () => {
    const m = manifest();
    const result = validateRestore(m, archive(m), { matrixServerName: "b.example" });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.code === "server-name-mismatch")).toBe(true);
  });

  it("names both sides and says what to change", () => {
    const m = manifest();
    const problem = validateRestore(m, archive(m), {
      matrixServerName: "b.example",
    }).problems.find(p => p.code === "server-name-mismatch");
    expect(problem?.message).toContain("a.example");
    expect(problem?.message).toContain("b.example");
    expect(problem?.message).toContain("MATRIX_SERVER_NAME");
  });

  it("does not object when the target hasn't been configured yet", () => {
    const m = manifest();
    expect(validateRestore(m, archive(m), {}).ok).toBe(true);
  });
});

describe("validateRestore — integrity", () => {
  it("refuses a corrupt component, even an optional one", () => {
    const m = manifest();
    const a = archive(m);
    a.files[3].sha256 = "f".repeat(64); // ipfs_data.tar.gz — optional
    const result = validateRestore(m, a);
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.code === "checksum-mismatch")).toBe(true);
  });

  it("treats a missing required component as fatal", () => {
    const m = manifest();
    const a = archive(m);
    a.files = a.files.filter(f => f.file !== "database.sql");
    const result = validateRestore(m, a);
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(p => p.code === "component-missing" && p.severity === "fatal")
    ).toBe(true);
  });

  it("treats a missing optional component as a warning", () => {
    const m = manifest();
    const a = archive(m);
    a.files = a.files.filter(f => f.file !== "matrix_key.pem");
    const result = validateRestore(m, a);
    expect(result.ok).toBe(true);
    expect(
      result.problems.some(p => p.code === "component-missing" && p.severity === "warning")
    ).toBe(true);
  });

  it("warns loudly about a backup with no signing key", () => {
    const m = manifest({
      components: manifest().components.filter(c => c.file !== "matrix_key.pem"),
    });
    const problem = validateRestore(m, archive(m)).problems.find(
      p => p.code === "component-absent"
    );
    expect(problem?.message).toContain("different server");
  });

  it("refuses a backup with no database at all", () => {
    const m = manifest({
      components: manifest().components.filter(c => c.file !== "database.sql"),
    });
    const result = validateRestore(m, archive(m));
    expect(result.ok).toBe(false);
    expect(
      result.problems.some(p => p.code === "component-absent" && p.severity === "fatal")
    ).toBe(true);
  });

  it("flags a size mismatch without blocking the restore", () => {
    const m = manifest();
    const a = archive(m);
    a.files[0].bytes = 999;
    const result = validateRestore(m, a);
    expect(result.ok).toBe(true);
    expect(result.problems.some(p => p.code === "size-mismatch")).toBe(true);
  });
});

describe("validateRestore — versions", () => {
  it("refuses a backup written in a newer format", () => {
    const m = manifest({ formatVersion: BACKUP_FORMAT_VERSION + 1 });
    const result = validateRestore(m, archive(m));
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.code === "format-too-new")).toBe(true);
  });

  it("refuses a schema this build has never heard of", () => {
    const m = manifest();
    const result = validateRestore(m, archive(m), { knownSchemas: ["0000_a", "0001_b"] });
    expect(result.ok).toBe(false);
    expect(result.problems.some(p => p.code === "schema-unknown")).toBe(true);
  });

  it("accepts an older schema and says migrations will run", () => {
    const m = manifest();
    const result = validateRestore(m, archive(m), {
      knownSchemas: ["0005_fuzzy_kylun", "0006_later"],
    });
    expect(result.ok).toBe(true);
    const problem = result.problems.find(p => p.code === "schema-older");
    expect(problem?.severity).toBe("warning");
    expect(problem?.message).toContain("automatically");
  });

  it("says nothing about schema when the target ships no list", () => {
    const m = manifest();
    const result = validateRestore(m, archive(m), {});
    expect(result.problems.some(p => p.code.startsWith("schema"))).toBe(false);
  });

  it("warns but does not refuse on a protocol major difference", () => {
    const m = manifest({
      versions: { app: "0.9.0", protocol: { major: 2, minor: 0 }, schema: null },
    });
    const result = validateRestore(m, archive(m));
    expect(result.problems.some(p => p.code === "protocol-major-differs")).toBe(true);
    expect(result.problems.find(p => p.code === "protocol-major-differs")?.severity).toBe(
      "warning"
    );
  });

  it("ignores the application version entirely", () => {
    const m = manifest({
      versions: { app: "0.1.0", protocol: { major: 1, minor: 0 }, schema: null },
    });
    const result = validateRestore(m, archive(m), { appVersion: "9.9.9" });
    expect(result.ok).toBe(true);
  });
});

describe("describeValidation", () => {
  it("leads with what blocks the restore", () => {
    const m = manifest();
    const text = describeValidation(validateRestore(m, archive(m), { matrixServerName: "b.example" }));
    expect(text.startsWith("Cannot restore")).toBe(true);
  });

  it("reassures when only warnings remain", () => {
    const m = manifest({
      components: manifest().components.filter(c => c.file !== "matrix_key.pem"),
    });
    const text = describeValidation(validateRestore(m, archive(m)));
    expect(text).toContain("Nothing here blocks the restore");
  });
});

describe("component contract", () => {
  it("requires the database and nothing else", () => {
    const required = Object.entries(COMPONENTS)
      .filter(([, spec]) => spec.required)
      .map(([name]) => name);
    expect(required).toEqual(["database"]);
  });

  it("explains the cost of every optional component", () => {
    for (const [name, spec] of Object.entries(COMPONENTS)) {
      expect(spec.ifMissing.length, name).toBeGreaterThan(10);
    }
  });
});

describe("backupFilename", () => {
  it("carries the instance id and sorts chronologically", () => {
    const early = backupFilename("abc123", new Date("2026-01-02T03:04:05Z"));
    const later = backupFilename("abc123", new Date("2026-11-02T03:04:05Z"));
    expect(early).toBe("sovrgnnet_abc123_20260102_030405.sovbackup");
    expect([later, early].sort()).toEqual([early, later]);
  });
});
