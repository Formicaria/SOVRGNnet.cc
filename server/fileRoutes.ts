import express, { type Express } from "express";
import { authenticateRequest } from "./_core/auth";
import * as db from "./db";
import { addFile, catFile } from "./ipfsService";

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
          return res.status(400).json({ error: "channelId and filename are required" });
        }
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          return res.status(400).json({ error: "Empty upload" });
        }

        const channel = await db.getChannelById(channelId);
        if (!channel) return res.status(404).json({ error: "Channel not found" });
        if (!(await db.isServerMember(channel.serverId, user.id))) {
          return res.status(403).json({ error: "Not a member of this server" });
        }

        const cid = await addFile(body, filename);
        const mimeType =
          String(req.headers["content-type"] ?? "application/octet-stream").split(";")[0];

        const share = await db.createFileShare(
          channelId,
          user.id,
          filename,
          cid,
          body.length,
          mimeType
        );
        return res.status(201).json(share);
      } catch (err) {
        console.error("[upload]", err);
        return res.status(500).json({ error: "Upload failed" });
      }
    }
  );

  // Serve a shared file by CID, with membership enforcement.
  app.get("/api/files/:cid", async (req, res) => {
    try {
      const user = await authenticateRequest(req);
      if (!user) return res.status(401).json({ error: "Unauthorized" });

      const share = await db.getFileShareByCid(req.params.cid);
      if (!share) return res.status(404).json({ error: "File not found" });

      const channel = await db.getChannelById(share.channelId);
      if (!channel || !(await db.isServerMember(channel.serverId, user.id))) {
        return res.status(403).json({ error: "Not a member of this server" });
      }

      const bytes = await catFile(share.ipfsHash);
      res.setHeader("Content-Type", share.mimeType ?? "application/octet-stream");
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
