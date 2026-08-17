import express, { type Express } from "express";
import { authenticateRequest } from "./_core/auth";
import * as db from "./db";
import { addFile, catFile, unpinFile } from "./ipfsService";
import { ensureMatrixCredentials } from "./matrixBridge";
import { sendFileNotice } from "./matrixService";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // aligned with body-parser limits & Cloudflare free tier headroom

/**
 * REST routes for file sharing. tRPC handles metadata (listing); these two
 * routes move the actual bytes, which tRPC is the wrong tool for.
 */
export function registerFileRoutes(app: Express): void {
  // Upload a file into a channel. Body is the raw file bytes.
  app.post(
    "/api/upload",
    express.raw({ type: "*/*", limit: MAX_UPLOAD_BYTES }),
    async (req, res) => {
      try {
        const user = await authenticateRequest(req);
        if (!user) return res.status(401).json({ error: "Unauthorized" });

        const channelId = Number(req.query.channelId);
        const filename = String(req.query.filename ?? "").slice(0, 255);
        if (!Number.isInteger(channelId) || !filename) {
          return res
            .status(400)
            .json({ error: "channelId and filename are required" });
        }
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: "Empty upload" });
        }

        const channel = await db.getChannelById(channelId);
        if (!channel)
          return res.status(404).json({ error: "Channel not found" });
        if (!(await db.isServerMember(channel.serverId, user.id))) {
          return res.status(403).json({ error: "Not a member of this server" });
        }

        const cid = await addFile(body, filename);
        const mimeType = String(
          req.headers["content-type"] ?? "application/octet-stream"
        ).split(";")[0];

        const share = await db.createFileShare(
          channelId,
          user.id,
          filename,
          cid,
          body.length,
          mimeType
        );

        // Announce the share in the room so clients on direct sync hear it
        // (ADR 0008 stage 3). Best-effort: the upload already succeeded, and a
        // homeserver hiccup shouldn't turn a stored file into a 500 — clients
        // still on the polling fallback will see it within one interval.
        //
        // Not for an encrypted channel. Two reasons, and the second is the
        // one that matters: this notice would be a plaintext `m.room.message`
        // in a room whose members believe otherwise, and — because the
        // decryption key for the bytes rides inside the event — only a client
        // holding room keys can compose the event at all. So the client sends
        // it, over its own session, encrypted, with the key inside. The
        // instance stores ciphertext and never sees the key.
        if (!channel.encrypted) {
          try {
            const creds = await ensureMatrixCredentials(user);
            await sendFileNotice(creds.accessToken, channel.matrixRoomId, {
              filename,
              cid,
              size: body.length,
              mimeType,
            });
          } catch (err) {
            console.warn("[upload] file notice not sent:", err);
          }
        }

        return res.status(201).json(share);
      } catch (err) {
        console.error("[upload]", err);
        return res.status(500).json({ error: "Upload failed" });
      }
    }
  );

  /**
   * Abandon an upload whose key never got published.
   *
   * Encrypted attachments are pinned before the room event carrying their
   * decryption key is sent — the CID doesn't exist until the upload finishes,
   * so there is no other order. If that send fails, the bytes on the node are
   * unreadable by everyone forever, including the person who uploaded them.
   * This is how the client cleans up after itself instead of leaving them.
   *
   * Scoped to the uploader, and addressed by share id rather than CID: the
   * same bytes can be shared into more than one channel, and "delete the file
   * with this CID" would be ambiguous in exactly the case where getting it
   * wrong deletes somebody else's working file.
   */
  app.delete("/api/uploads/:shareId", async (req, res) => {
    try {
      const user = await authenticateRequest(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const shareId = Number(req.params.shareId);
      if (!Number.isInteger(shareId)) {
        return res.status(400).json({ error: "Bad share id" });
      }

      const outcome = await db.deleteOwnFileShare(shareId, user.id);
      if (!outcome.deleted) {
        // Not found and not-yours are the same answer on purpose: otherwise
        // this reports whether a share id exists to anyone who asks.
        return res.status(404).json({ error: "No such upload" });
      }

      // Only unpin when nothing else points at those bytes. Content addressing
      // means a second share of the same file is the same CID, and unpinning
      // because this upload failed would break the other one.
      if (outcome.cid && !outcome.cidStillShared) {
        const unpinned = await unpinFile(outcome.cid);
        if (!unpinned) {
          console.warn(
            `[upload] abandoned ${outcome.cid} but couldn't unpin it`
          );
        }
      }

      return res.json({ abandoned: true });
    } catch (err) {
      console.error("[upload:abandon]", err);
      return res.status(500).json({ error: "Couldn't abandon that upload" });
    }
  });

  // Serve a shared file by CID, with membership enforcement.
  app.get("/api/files/:cid", async (req, res) => {
    try {
      const user = await authenticateRequest(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const shares = await db.getFileSharesByCid(req.params.cid);
      if (shares.length === 0)
        return res.status(404).json({ error: "File not found" });

      // Every share of these bytes, not just the first row. The same file
      // posted in two channels is one CID and two rows, and checking only the
      // first refuses people entitled to it through the second — a 403 whose
      // truth depends on insertion order.
      let share: (typeof shares)[number] | undefined;
      for (const candidate of shares) {
        const channel = await db.getChannelById(candidate.channelId);
        if (channel && (await db.isServerMember(channel.serverId, user.id))) {
          share = candidate;
          break;
        }
      }
      if (!share) {
        return res.status(403).json({ error: "Not a member of this server" });
      }

      const bytes = await catFile(share.ipfsHash);
      res.setHeader(
        "Content-Type",
        share.mimeType ?? "application/octet-stream"
      );
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${encodeURIComponent(share.filename)}"`
      );
      res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
      return res.send(bytes);
    } catch (err) {
      console.error("[files]", err);
      return res.status(500).json({ error: "File retrieval failed" });
    }
  });
}
