import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

/**
 * The identity provider's own database.
 *
 * Separate from any server's, holding accounts and nothing else — no
 * messages, no memberships, no idea which communities anyone belongs to. This
 * service is already a concentration of risk; there's no reason to make it a
 * more interesting target than it has to be.
 */

let instance: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (instance) return instance;

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — the identity provider needs its own database.");
  }

  instance = drizzle(postgres(url));
  return instance;
}
