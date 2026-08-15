import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Apply pending database migrations at startup.
 *
 * Nobody should have to run a migration command by hand to use SOVRGNnet.
 * The app owns its schema: on every boot it connects, applies whatever
 * migrations haven't run yet, and continues. Drizzle records applied
 * migrations in `drizzle.__drizzle_migrations`, so this is a no-op once the
 * database is current, and it's safe to run on every container restart.
 *
 * We deliberately use drizzle-orm's runtime migrator rather than the
 * drizzle-kit CLI: drizzle-kit is a dev dependency and isn't present in the
 * production image, while the generated .sql files are.
 */
export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.warn("[Migrate] DATABASE_URL not set — skipping migrations.");
    return;
  }

  const migrationsFolder = resolve(process.cwd(), "drizzle");
  if (!existsSync(migrationsFolder)) {
    console.warn(`[Migrate] No migrations folder at ${migrationsFolder} — skipping.`);
    return;
  }

  // A dedicated single-connection client: migrations must run serially, and
  // this one is closed as soon as they're done.
  const client = postgres(connectionString, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder });
    console.log("[Migrate] Database schema is up to date.");
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Wait for Postgres to accept connections.
 *
 * Compose's `depends_on: service_healthy` covers the usual case, but a
 * restarting database, a slow first boot on modest hardware, or a managed
 * Postgres elsewhere can all leave us racing the server. Retrying with a
 * clear message beats crash-looping with a stack trace.
 */
export async function waitForDatabase(
  attempts = 30,
  delayMs = 2000
): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = postgres(connectionString, {
      max: 1,
      connect_timeout: 5,
      onnotice: () => {},
    });
    try {
      await client`select 1`;
      await client.end({ timeout: 5 });
      return true;
    } catch (error) {
      await client.end({ timeout: 5 }).catch(() => {});
      if (attempt === attempts) {
        console.error(
          `[Migrate] Database unreachable after ${attempts} attempts:`,
          error instanceof Error ? error.message : error
        );
        return false;
      }
      if (attempt === 1) {
        console.log("[Migrate] Waiting for the database to accept connections...");
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return false;
}
