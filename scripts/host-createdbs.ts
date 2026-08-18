/**
 * Create the host's two databases, without `createdb`.
 *
 *   node createdbs.mjs sovrgnnet dendrite
 *
 * Connection details come from the standard PG* environment variables, the
 * same ones `createdb` itself reads.
 *
 * ## Why this exists
 *
 * `hosting.rs` used to spawn `createdb` from the bundled PostgreSQL. zonky's
 * embedded-postgres binaries — which is what the bundle ships, because it is
 * plain PostgreSQL repackaged per platform on Maven Central — **do not include
 * the client tools on every platform**. Windows and Linux have no `createdb`;
 * macOS does.
 *
 * That asymmetry is the dangerous part. A bundle built on a Mac works, ships,
 * and fails on somebody else's Windows machine three steps into a first run
 * with `The system cannot find the file specified`. It is not a missing file
 * anyone would think to check for, because it was there when it was built.
 *
 * `createdb` is a thin wrapper around `CREATE DATABASE` anyway. Doing it over
 * a connection removes the dependency instead of working around it, and the
 * bundle already ships both Node and the `postgres` driver.
 *
 * Exits 0 when the databases exist, whether this run created them or a
 * previous one did — the ordinary second launch is not an error.
 */

import postgres from "postgres";

/**
 * A database name that is safe to interpolate.
 *
 * `CREATE DATABASE` takes an identifier, not a parameter, so the name cannot
 * be bound and has to be substituted into the statement. These names are
 * hard-coded by the caller today; validating anyway means that stays true even
 * if someone later passes one through from somewhere less trustworthy.
 */
function assertSafeName(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`Refusing to create a database named ${JSON.stringify(name)}`);
  }
  return name;
}

async function main(): Promise<void> {
  const names = process.argv.slice(2).map(assertSafeName);
  if (names.length === 0) throw new Error("No database names given.");

  // `postgres` is the maintenance database initdb always creates. Connecting
  // to one of the databases we are about to create would be circular.
  const sql = postgres({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "postgres",
    password: process.env.PGPASSWORD ?? "",
    database: "postgres",
    max: 1,
    // The supervisor already waited for the port to accept connections. A
    // short timeout here keeps a misconfiguration from hanging the whole
    // first-run screen with no explanation.
    connect_timeout: 15,
    onnotice: () => {},
  });

  try {
    for (const name of names) {
      const existing = await sql`
        SELECT 1 FROM pg_database WHERE datname = ${name}
      `;
      if (existing.length > 0) {
        console.log(`[createdbs] ${name} already exists`);
        continue;
      }

      // CREATE DATABASE cannot run inside a transaction, which is why this is
      // a bare unsafe() rather than anything wrapped. The name is validated
      // above; nothing else is interpolated.
      await sql.unsafe(`CREATE DATABASE "${name}"`);
      console.log(`[createdbs] ${name} created`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  // stderr, so the supervisor's run_to_completion surfaces it as the failure
  // reason rather than a bare exit code.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
