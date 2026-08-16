import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type Request } from "express";
import * as db from "./db";

/**
 * The application-service ingest — ADR 0009.
 *
 * The homeserver pushes every event in our namespace here, in order, with
 * retries, exactly once per transaction id. This is how the database learns
 * about events the instance did not compose: client-authored messages today,
 * ciphertext it cannot read under stage 4.
 *
 * Two tokens exist, named from the homeserver's point of view:
 *  - `hs_token`  — the homeserver proves itself to us. Checked here.
 *  - `as_token`  — we prove ourselves to the homeserver. Unused until the
 *    instance calls appservice-authenticated endpoints.
 *
 * Both live in the registration file the operator wires into the homeserver;
 * `eventIngest` in the instance descriptor is true only when both are set,
 * because clients must not author events an instance cannot record.
 */

export function appserviceConfigured(): boolean {
  return Boolean(
    process.env.MATRIX_APPSERVICE_HS_TOKEN && process.env.MATRIX_APPSERVICE_AS_TOKEN
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  // Hash both sides first so length differences don't leak through
  // timingSafeEqual's length requirement.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function presentedToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  // Older spec versions carried it as a query parameter; Dendrite still sends
  // both. Accepted, never logged.
  const query = req.query.access_token;
  return typeof query === "string" ? query : null;
}

export interface AppserviceEvent {
  type?: string;
  event_id?: string;
  sender?: string;
  room_id?: string;
  origin_server_ts?: number;
  redacts?: string;
  content?: {
    msgtype?: string;
    body?: string;
    "m.relates_to"?: { rel_type?: string; event_id?: string };
    "m.new_content"?: { body?: string };
    [key: string]: unknown;
  };
}

export interface IngestOutcome {
  inserted: number;
  edited: number;
  redacted: number;
  encrypted: number;
  stateChanged: number;
  skipped: number;
}

/**
 * Apply one homeserver event to the index. Never throws for content it
 * doesn't understand — the transaction is retried wholesale, so a permanently
 * unprocessable event would wedge every event behind it.
 */
export async function ingestEvent(event: AppserviceEvent): Promise<keyof IngestOutcome> {
  const roomId = event.room_id;
  const eventId = event.event_id;
  const sender = event.sender;
  if (!roomId || !eventId || !sender) return "skipped";

  if (event.type === "m.room.encryption") {
    // A client switched the room to encrypted. The index records it so the
    // API stops accepting plaintext into it — Matrix never downgrades this
    // state, and neither do we.
    return (await db.markChannelEncrypted(roomId)) ? "stateChanged" : "skipped";
  }

  if (event.type === "m.room.redaction") {
    const target = event.redacts ?? (event.content as { redacts?: string })?.redacts;
    if (!target) return "skipped";
    return (await db.deleteMessageByEventId(target)) ? "redacted" : "skipped";
  }

  if (event.type === "m.room.encrypted") {
    // Stage 4's shape, handled before any ciphertext exists: the index keeps
    // ordering, sender, and timestamps while holding nothing readable.
    const channel = await db.getChannelByMatrixRoomId(roomId);
    if (!channel) return "skipped";
    const userId = await db.getUserIdByMatrixId(sender);
    if (userId == null) return "skipped";
    const inserted = await db.ingestMessage(
      channel.id,
      userId,
      "",
      eventId,
      true,
      event.origin_server_ts
    );
    return inserted ? "encrypted" : "skipped";
  }

  if (event.type !== "m.room.message") return "skipped";

  const relation = event.content?.["m.relates_to"];
  if (relation?.rel_type === "m.replace" && relation.event_id) {
    const newBody = event.content?.["m.new_content"]?.body;
    if (typeof newBody !== "string" || !newBody) return "skipped";
    return (await db.applyEditByEventId(relation.event_id, newBody))
      ? "edited"
      : "skipped";
  }

  const msgtype = event.content?.msgtype;
  const body = event.content?.body;
  // File notices carry a CID, not content; the upload route already recorded
  // the share. Anything without a text body has nothing for a text index.
  if (msgtype !== "m.text" || typeof body !== "string" || !body) return "skipped";

  const channel = await db.getChannelByMatrixRoomId(roomId);
  if (!channel) return "skipped";
  const userId = await db.getUserIdByMatrixId(sender);
  if (userId == null) return "skipped";

  const inserted = await db.ingestMessage(
    channel.id,
    userId,
    body,
    eventId,
    false,
    event.origin_server_ts
  );
  return inserted ? "inserted" : "skipped";
}

export async function ingestTransaction(
  events: AppserviceEvent[]
): Promise<IngestOutcome> {
  const outcome: IngestOutcome = {
    inserted: 0,
    edited: 0,
    redacted: 0,
    encrypted: 0,
    stateChanged: 0,
    skipped: 0,
  };
  for (const event of events) {
    try {
      outcome[await ingestEvent(event)] += 1;
    } catch (err) {
      // A single bad event must not wedge the transaction queue. It is
      // counted and logged; the homeserver considers it delivered.
      outcome.skipped += 1;
      console.warn("[appservice] event not ingested:", err);
    }
  }
  return outcome;
}

export function registerAppserviceRoutes(app: Express): void {
  const handler = async (req: Request, res: express.Response) => {
    const expected = process.env.MATRIX_APPSERVICE_HS_TOKEN;
    if (!expected) {
      // Not configured: this surface does not exist.
      return res.status(404).json({ errcode: "M_UNRECOGNIZED" });
    }

    const presented = presentedToken(req);
    if (!presented || !constantTimeEqual(presented, expected)) {
      console.warn("[appservice] transaction with bad hs_token rejected");
      return res.status(403).json({ errcode: "M_FORBIDDEN" });
    }

    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    const outcome = await ingestTransaction(events as AppserviceEvent[]);
    if (
      outcome.inserted || outcome.edited || outcome.redacted ||
      outcome.encrypted || outcome.stateChanged
    ) {
      console.log(
        `[appservice] txn ${req.params.txnId}: ` +
          `+${outcome.inserted} msg, ${outcome.edited} edit, ` +
          `${outcome.redacted} redact, ${outcome.encrypted} encrypted, ` +
          `${outcome.stateChanged} state, ${outcome.skipped} skipped`
      );
    }
    // Wholesale acknowledgement — see ADR 0009.
    return res.json({});
  };

  app.put("/_matrix/app/v1/transactions/:txnId", express.json({ limit: "10mb" }), handler);
  // The pre-v1.1 path some homeservers still use.
  app.put("/transactions/:txnId", express.json({ limit: "10mb" }), handler);
}
