import http from "node:http";
import https from "node:https";
import type { Express, Request, Response } from "express";
import { ENV } from "./_core/env";

/**
 * The homeserver, at the instance's own address — ADR 0015.
 *
 * End-to-end encryption needs every client to hold its own Matrix session,
 * which needs every client to reach the homeserver. For two releases that was
 * an operator's job: expose Dendrite somewhere, set MATRIX_PUBLIC_URL to it,
 * and `clientMatrix` would become true. No stock deployment did it — the
 * desktop host has no operator, and the Docker one was told the step was
 * optional — so encryption was implemented, honest about itself, and off.
 *
 * This makes the homeserver reachable wherever the app is. Requests under
 * `/_matrix/client`, `/_matrix/media` and `/_matrix/key` are streamed to
 * Dendrite on loopback and the answer streamed back, so the address a client
 * already has for the app — the tunnel, the LAN, 127.0.0.1 — is also its
 * homeserver address. One origin, nothing to expose, nothing to configure.
 *
 * `/_matrix/app` is deliberately not on the list. That is the appservice's
 * *inbound* — Dendrite pushing events to the app, hs-token gated — and a
 * client must never be able to reach it. The registration file names the
 * app's loopback address, and that is the only place it should be dialled
 * from.
 *
 * Streamed rather than buffered, and mounted before body parsing, because
 * two Matrix requests are unlike the rest of the app's traffic: media
 * uploads are large, and `/sync` holds the connection open for as long as the
 * client asked (30s is typical). `express.json` buffering the first would
 * cost the 50MB limit per upload; anything timing out the second would break
 * sync. Node's http module does both correctly with no third party in the
 * middle, which is the same reason the desktop supervisor carries no crates.
 */

/** The prefixes that are the client-server API and its media and key surfaces. */
export const PROXIED_PREFIXES = [
  "/_matrix/client/",
  "/_matrix/media/",
  "/_matrix/key/",
] as const;

export function isProxiedPath(path: string): boolean {
  return PROXIED_PREFIXES.some(prefix => path.startsWith(prefix));
}

/**
 * Headers that describe the connection rather than the message. RFC 7230
 * §6.1: a proxy must not forward these, and Node handles the ones that
 * matter (chunking, keep-alive) itself on each hop.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * The origin a request arrived on, as the client sees it.
 *
 * This is what a delegation document and a client session have to name:
 * the homeserver is reachable at *this* address because this address reached
 * the app. Behind the tunnel or a reverse proxy the honest values are in the
 * forwarded headers; on a direct connection they are the request's own.
 * `shareableHost` deliberately does not apply here — that rewrites loopback
 * into an address *other people* can dial, and a session belongs to the one
 * client that opened it, at the address it opened it on.
 */
export function requestOrigin(req: Pick<Request, "headers" | "protocol">): string {
  const forwardedProto = first(req.headers["x-forwarded-proto"]);
  const forwardedHost = first(req.headers["x-forwarded-host"]);
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol || "http";
  const host = forwardedHost?.split(",")[0]?.trim() || first(req.headers.host) || "";
  return host ? `${proto}://${host}` : "";
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface MatrixProxyOptions {
  /** Where the homeserver actually is. Read per request so tests can point it at a stand-in. */
  target?: () => string;
}

export function registerMatrixProxy(app: Express, options: MatrixProxyOptions = {}): void {
  const target = options.target ?? (() => ENV.matrixHomeserverUrl);
  app.use((req, res, next) => {
    if (!isProxiedPath(req.path)) return next();
    proxy(req, res, target());
  });
}

function proxy(req: Request, res: Response, base: string): void {
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(base);
  } catch {
    res.status(502).json({ errcode: "M_UNKNOWN", error: "The homeserver address is invalid." });
    return;
  }
  const transport = upstreamUrl.protocol === "https:" ? https : http;

  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    headers[name] = value;
  }
  // The upstream must see its own name, and know whose it is answering for.
  headers.host = upstreamUrl.host;
  headers["x-forwarded-for"] = req.ip ?? "";
  headers["x-forwarded-proto"] = req.protocol;
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;

  const upstream = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      method: req.method,
      // originalUrl carries the query string; req.path does not.
      path: req.originalUrl,
      headers,
    },
    answer => {
      res.status(answer.statusCode ?? 502);
      for (const [name, value] of Object.entries(answer.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name)) continue;
        res.setHeader(name, value);
      }
      answer.pipe(res);
    }
  );

  upstream.on("error", () => {
    // Before any byte has gone back, say so in the protocol's own shape so
    // a Matrix client reports "homeserver unreachable" rather than a parse
    // error. After, the only honest thing is to cut the connection: a body
    // that stops mid-way is a truncated body, not a status code.
    if (!res.headersSent) {
      res.status(502).json({ errcode: "M_UNKNOWN", error: "The homeserver didn't answer." });
    } else {
      res.destroy();
    }
  });

  // A client that went away takes its upstream request with it — otherwise
  // an abandoned /sync holds a Dendrite worker for the rest of its timeout.
  //
  // On the response, not the request. `req` is the readable half, and its
  // "close" fires as soon as the body has been consumed — for a GET, before
  // the upstream has even answered — which made the first version of this
  // destroy every request it forwarded. `res` closes when the connection
  // does; `writableFinished` is false only if that happened before the end.
  res.on("close", () => {
    if (!res.writableFinished && !upstream.destroyed) upstream.destroy();
  });

  req.pipe(upstream);
}
