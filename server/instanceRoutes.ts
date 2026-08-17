import type { Express } from "express";
import { APP_VERSION } from "@shared/const";
import { isValidInviteCode } from "@shared/invite";
import { clientDelegation, serverDelegation } from "@shared/matrixDelegation";
import { PROTOCOL_VERSION } from "@shared/protocol";
import * as db from "./db";
import { instanceDescriptor, instanceInfo } from "./instance";
import * as matrix from "./matrixService";

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

    // Whether this instance still has no accounts, so the sign-up form knows
    // to ask for the setup code.
    //
    // Not a leak worth worrying about: anyone can learn the same thing by
    // attempting to register and reading the refusal, and knowing it buys
    // nothing without the code. Outside the formal descriptor deliberately —
    // it's a transient fact about one deployment's state, not part of the
    // protocol contract, and it stops being true permanently after one signup.
    //
    // Bounded, and false on anything but a clear answer. This endpoint is how
    // a client discovers an instance at all, so it has to answer even when the
    // database doesn't — the same lesson `/ready` learned by hanging. Erring
    // to false means a genuinely fresh instance briefly hides the setup field
    // rather than every client hanging on discovery, and the registration
    // attempt still refuses correctly either way.
    // The try/catch is not belt-and-braces: `Promise.race` only guards a
    // promise that exists, and a synchronous throw here — an unavailable
    // database layer, a mock without this method — would escape it and take
    // the whole endpoint down with a 500.
    let needsSetup = false;
    try {
      needsSetup = await Promise.race([
        db
          .countUsers()
          .then(count => count === 0)
          .catch(() => false),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1500)),
      ]);
    } catch {
      needsSetup = false;
    }

    // Both shapes, one response. The v0.1–v0.3 fields stay exactly where old
    // clients expect them; `protocol`, `capabilities`, and `matrix` are added
    // alongside. Independently operated instances and clients upgrade on their
    // own schedules, so neither may be forced to move first.
    res.json({
      ...instanceInfo(APP_VERSION, stored),
      ...instanceDescriptor(APP_VERSION, stored),
      needsSetup,
    });
  });

  /**
   * Just the capabilities, for a client deciding what to offer.
   *
   * Separate from the full descriptor because it's the part worth polling —
   * an operator turning federation on shouldn't need a client restart.
   */
  app.get("/api/capabilities", async (_req, res) => {
    res.set("Cache-Control", "public, max-age=60");
    res.set("Access-Control-Allow-Origin", "*");
    const stored = await db.getInstanceSettings().catch(() => null);
    const descriptor = instanceDescriptor(APP_VERSION, stored);
    res.json({
      protocol: descriptor.protocol,
      capabilities: descriptor.capabilities,
    });
  });

  /** Version, for humans and for compatibility checks. */
  app.get("/api/version", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.json({
      server: APP_VERSION,
      protocol: `${PROTOCOL_VERSION.major}.${PROTOCOL_VERSION.minor}`,
    });
  });

  /**
   * Liveness: is this process up at all?
   *
   * Deliberately answers without touching the database — a health check that
   * needs Postgres can't tell you the difference between "the app is down" and
   * "the database is down", which is the distinction you most want at 3am.
   */
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
  });

  /**
   * Readiness: can this instance actually serve requests?
   *
   * Reports each dependency separately, and treats only the database as
   * fatal. A dead IPFS means file sharing fails while conversations continue,
   * and reporting that as "not ready" would take a working instance out of
   * rotation for a partial outage.
   */
  app.get("/ready", async (_req, res) => {
    const checks: Record<string, "ok" | "down"> = {
      database: "down",
      matrix: "down",
    };

    // Every check is bounded. An unbounded one doesn't make this endpoint slow,
    // it makes it *hang* — and a readiness probe that never answers is worse
    // than one reporting a failure, because a caller sees a timeout instead of
    // information. The homeserver check did exactly this while Dendrite was
    // starting, and took /ready down with it.
    // Read per request so tests can shorten it without waiting out the real
    // bound, and so an operator on slow storage can raise it.
    const limit = Number(process.env.READY_TIMEOUT_MS ?? 3000);

    const timeout = <T>(work: Promise<T>, fallback: T): Promise<T> =>
      Promise.race([
        work,
        new Promise<T>(resolve => setTimeout(() => resolve(fallback), limit)),
      ]);

    // pingDatabase, not getInstanceSettings. The latter catches its own errors
    // and returns null by design, so this endpoint used to report the database
    // as healthy when there was no database at all.
    const database = await timeout(db.pingDatabase(), {
      ok: false,
      error: "timed out",
    });
    checks.database = database.ok ? "ok" : "down";

    // Bounded twice: once inside isHomeserverReachable, once here. The inner
    // bound is the real one; this catches anything that never resolves at all.
    checks.matrix = (await timeout(matrix.isHomeserverReachable(limit), false))
      ? "ok"
      : "down";

    const ready = checks.database === "ok";
    res.status(ready ? 200 : 503).json({
      ready,
      checks,
      ...(database.error ? { detail: { database: database.error } } : {}),
    });
  });

  /**
   * Matrix delegation.
   *
   * A Matrix ID is `@zach:example.com`, and clients take the part after the
   * colon and ask that host where the homeserver actually lives. Serving these
   * from the app means delegation works in every deployment shape, rather than
   * only where someone configured nginx by hand.
   *
   * Both must be readable cross-origin — a Matrix client on another origin is
   * exactly who reads them.
   */
  app.get("/.well-known/matrix/client", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=300");

    // No m.identity_server: that field names a *Matrix* identity service
    // (sydent — email and phone lookup), which this project doesn't run. The
    // SOVRGN identity provider is a different thing entirely, and advertising
    // it here would point Matrix clients at something that doesn't speak the
    // protocol they'd use it with.
    const document = clientDelegation(process.env.MATRIX_PUBLIC_URL ?? null);

    // 404 rather than an empty document. A client that gets a 404 falls back
    // to its own default sensibly; one handed a delegation pointing nowhere
    // fails later and less clearly.
    if (!document) return res.status(404).json({ errcode: "M_NOT_FOUND" });
    res.json(document);
  });

  app.get("/.well-known/matrix/server", (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=300");

    // Gated on federation actually being on. Advertising a federation
    // endpoint while refusing federated traffic invites other servers to try
    // and then fail, which is worse than saying nothing.
    const document = serverDelegation(
      process.env.MATRIX_PUBLIC_URL ?? null,
      process.env.MATRIX_ALLOW_FEDERATION === "true"
    );

    if (!document) return res.status(404).json({ errcode: "M_NOT_FOUND" });
    res.json(document);
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
        return res
          .status(404)
          .json({ error: "This invite is no longer valid" });
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
