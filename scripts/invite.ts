/**
 * Operator CLI for invite codes — the thing you run on the box.
 *
 *   pnpm invite                          show every server's invite
 *   pnpm invite --cycle                  rotate the code (one server on the box)
 *   pnpm invite --cycle --server 3       rotate one server's code by id
 *   pnpm invite --host chat.example.com  print full URLs for that public host
 *
 * Rotating ("cycling") replaces the code, which is the whole point: an invite
 * that leaked into a screenshot or an old group chat stops working the moment
 * a new one exists. The old code is gone, not archived — there is exactly one
 * live code per server, same as the app's own invite button uses.
 *
 * The host flag exists because this process serves no HTTP request: the app
 * derives invite URLs from the Host header, and a CLI has no header to read.
 * Without --host (or SOVRGN_PUBLIC_HOST in the environment) it prints the
 * code and the path, which is enough to paste onto any address you know.
 */

import { nanoid } from "nanoid";
import { inviteDeepLink, inviteUrl } from "../shared/invite";
import { servers } from "../drizzle/schema";
import { getDb, setServerInviteCode } from "../server/db";

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cycle = args.includes("--cycle");
  const serverFlag = args.indexOf("--server");
  const serverId = serverFlag >= 0 ? Number(args[serverFlag + 1]) : null;
  if (serverFlag >= 0 && (!Number.isInteger(serverId) || (serverId as number) <= 0)) {
    fail("--server needs a numeric id (see the list this prints without --cycle)");
  }
  const hostFlag = args.indexOf("--host");
  const host =
    (hostFlag >= 0 ? args[hostFlag + 1] : process.env.SOVRGN_PUBLIC_HOST) ?? null;

  const db = await getDb();
  if (!db) fail("No database. Run this on the server box, where DATABASE_URL is set.");

  const rows = await db!.select().from(servers).orderBy(servers.id);
  if (rows.length === 0) fail("This instance has no servers yet.");

  const targets = serverId ? rows.filter(r => r.id === serverId) : rows;
  if (serverId && targets.length === 0) {
    fail(`No server with id ${serverId}. Ids on this box: ${rows.map(r => r.id).join(", ")}`);
  }
  if (cycle && !serverId && rows.length > 1) {
    fail(
      "Several servers here — say which code to roll: --cycle --server <id>\n" +
        rows.map(r => `  ${r.id}  ${r.name}`).join("\n")
    );
  }

  for (const server of targets) {
    let code = server.inviteCode;
    if (cycle || !code) {
      // Same shape the app mints (nanoid(10)); "no code yet" and "roll it"
      // are the same write.
      code = nanoid(10);
      await setServerInviteCode(server.id, code);
    }
    console.log(`${server.id}  ${server.name}${cycle ? "  (code rolled)" : ""}`);
    console.log(`    code: ${code}`);
    if (host) {
      console.log(`    url:  ${inviteUrl(host, code)}`);
      console.log(`    app:  ${inviteDeepLink(host, code)}`);
    } else {
      console.log(`    path: /invite/${code}   (pass --host for full URLs)`);
    }
  }
  process.exit(0);
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
