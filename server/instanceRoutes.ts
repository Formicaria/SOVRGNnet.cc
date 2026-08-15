import type { Express } from "express";
import { APP_VERSION } from "@shared/const";
import { isValidInviteCode } from "@shared/invite";
import * as db from "./db";
import { instanceInfo } from "./instance";

/**
 * Public, unauthenticated routes a client needs *before* it has an account.
 *
 * Everything here is deliberately readable by strangers, because a client
 * connecting to a server it has never seen is exactly the situation these
 * exist for. Nothing here exposes members, messages, or channel contents.
 */
export function registerInstanceRoutes(app: Express): void {
  /**
   * Who is this server?
   *
   * A client points at a host it was given and calls this first. If the
   * response doesn't say `product: "sovrgnnet"`, it isn't one of ours and the
   * client can say so plainly instead of failing at a login screen.
   */
  app.get("/api/instance", async (_req, res) => {
    // Short cache: an admin renaming their server should see it propagate in
    // a minute, not on the next restart.
    res.set("Cache-Control", "public, max-age=60");
    // A client on a different origin has to be able to read this — that's the
    // entire point of a multi-server client.
    res.set("Access-Control-Allow-Origin", "*");

    const stored = await db.getInstanceSettings().catch(() => null);
    res.json(instanceInfo(APP_VERSION, stored));
  });

  app.options("/api/instance", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.sendStatus(204);
  });

  /**
   * What am I being invited to?
   *
   * Lets a client show "Join **Zach's server** → #general?" before asking
   * anyone to create an account. Returns only the community's public face:
   * name, description, and whether the code is still good.
   *
   * Deliberately not exposed: member counts, channel lists, who invited you.
   * An invite code is a bearer token that anyone might forward, and it
   * shouldn't leak the shape of a community to someone who never joins.
   */
  app.get("/api/invite/:code", async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");

    const code = String(req.params.code ?? "");
    if (!isValidInviteCode(code)) {
      return res.status(400).json({ error: "Malformed invite code" });
    }

    try {
      const server = await db.getServerByInviteCode(code);
      if (!server) {
        // Same shape and status for "never existed" and "revoked" — there's no
        // reason to help someone enumerate which codes were once real.
        return res.status(404).json({ error: "This invite is no longer valid" });
      }

      const instance = instanceInfo(
        APP_VERSION,
        await db.getInstanceSettings().catch(() => null)
      );
      res.json({
        valid: true,
        server: {
          name: server.name,
          description: server.description,
          icon: server.icon,
        },
        instance: {
          id: instance.id,
          name: instance.name,
          matrixServerName: instance.matrixServerName,
          encryption: instance.encryption,
        },
      });
    } catch {
      res.status(503).json({ error: "Server is not ready" });
    }
  });
}
