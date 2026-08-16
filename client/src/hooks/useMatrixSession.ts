import { useCallback, useEffect, useRef, useState } from "react";
import type { EncryptedAttachment } from "@shared/attachments";
import type {
  CryptoSession,
  DecryptedMessage,
  FileAnnouncement,
  TimelineNotice,
  VerificationRequest,
} from "@/lib/matrixCrypto";
import { trpc } from "@/lib/trpc";

/**
 * The client's own Matrix session — ADR 0008 stages 3 and 4.
 *
 * This replaces `useDirectSync`, and with it the hand-rolled sync engine that
 * stage 3 shipped. There is one Matrix session on the client now, not one for
 * transport and another for crypto: two engines against the same homeserver
 * would mean two positions in the same stream, two answers to "has this event
 * arrived", and a bug with two candidate causes. ADR 0008 rejected doing
 * stages 3 and 4 together for that reason; keeping both engines afterwards
 * would have reintroduced it permanently.
 *
 * Everything about the SDK is behind a dynamic import. An instance that does
 * not advertise `clientMatrix` never fetches matrix-js-sdk, never fetches the
 * crypto WASM, and behaves exactly as it did in v0.5 — the polling fallback,
 * unchanged. That is not a bundle optimisation, it is the same capability
 * contract as before: an instance whose homeserver is on loopback is a
 * legitimate deployment and pays nothing for a feature it can't offer.
 *
 * Failure is quiet by design. Every path out of here that doesn't reach a live
 * session leaves `live` false and the caller on its fallback, because there is
 * nothing a user can do about a homeserver that didn't answer and an error
 * about it would be noise.
 */

const DEVICE_ID_KEY = "sovrgn.matrix.deviceId";

function deviceDisplayName(): string {
  const ua = navigator.userAgent;
  const browser = /firefox/i.test(ua)
    ? "Firefox"
    : /edg/i.test(ua)
      ? "Edge"
      : /chrome|chromium/i.test(ua)
        ? "Chrome"
        : /safari/i.test(ua)
          ? "Safari"
          : "Browser";
  const os = /linux/i.test(ua)
    ? "Linux"
    : /windows/i.test(ua)
      ? "Windows"
      : /mac/i.test(ua)
        ? "macOS"
        : /android/i.test(ua)
          ? "Android"
          : /iphone|ipad/i.test(ua)
            ? "iOS"
            : "";
  return os
    ? `SOVRGNnet web · ${browser} on ${os}`
    : `SOVRGNnet web · ${browser}`;
}

export type SessionEvent = TimelineNotice;

export type SessionState = "off" | "starting" | "live" | "error";

export interface MatrixSessionResult {
  /** True while a sync stream is delivering events. */
  live: boolean;
  state: SessionState;
  /**
   * True when this client may author events over its own session: the stream
   * is live AND the instance records homeserver pushes (ADR 0009). Without
   * the second half, a directly-sent message would be invisible to every
   * member on the API fallback.
   */
  canAuthor: boolean;
  /** Whether the instance advertises `e2ee`, independent of this session. */
  encryptionAvailable: boolean;
  /** The crypto machine, once it's running. Null on every other path. */
  session: CryptoSession | null;
  /**
   * Whether this device's encryption setup is complete — cross-signed,
   * verified, with a recovery key and a working backup. Null while unknown,
   * so callers can tell "not ready" from "not asked yet" and avoid showing a
   * warning badge that is really just a loading state.
   */
  cryptoReady: boolean | null;
  /**
   * Bumps whenever something the UI renders has changed inside the session —
   * a message decrypted, a device appeared, key backup came on. Callers use it
   * as a memo dependency; the alternative is copying the whole decrypted map
   * into React state on every to-device message.
   */
  revision: number;
  /** A verification another device has asked for, awaiting a decision. */
  pendingVerification: VerificationRequest | null;
  clearPendingVerification: () => void;
  send: (roomId: string, body: string) => Promise<string>;
  lookup: (eventId: string) => DecryptedMessage | undefined;
  backfill: (roomId: string) => Promise<void>;
  /** Announce an upload in the room, carrying the file's key if it has one. */
  sendFile: (roomId: string, file: FileAnnouncement) => Promise<string>;
  /**
   * The key for an uploaded file. `null` means the announcement said the file
   * isn't encrypted; `undefined` means no announcement has reached this device
   * yet, which is a different thing and the UI has to say so.
   */
  attachmentFor: (cid: string) => EncryptedAttachment | null | undefined;
}

export function useMatrixSession(
  enabled: boolean,
  onEvent: (event: SessionEvent) => void
): MatrixSessionResult {
  const [state, setState] = useState<SessionState>("off");
  const [ingests, setIngests] = useState(false);
  const [encryptionAvailable, setEncryptionAvailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [session, setSession] = useState<CryptoSession | null>(null);
  const [cryptoReady, setCryptoReady] = useState<boolean | null>(null);
  const [pendingVerification, setPendingVerification] =
    useState<VerificationRequest | null>(null);

  const sessionRef = useRef<CryptoSession | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const clientSession = trpc.matrix.clientSession.useMutation();
  const crossSigningAuth = trpc.matrix.completeCrossSigningAuth.useMutation();
  const clientSessionRef = useRef(clientSession);
  const crossSigningAuthRef = useRef(crossSigningAuth);
  clientSessionRef.current = clientSession;
  crossSigningAuthRef.current = crossSigningAuth;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let started: CryptoSession | null = null;
    // Decryption of a backfilled room fires per event; without coalescing,
    // paginating fifty messages is fifty renders of the whole message list.
    let scheduled = false;

    const bump = () => {
      if (cancelled || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!cancelled) setRevision(n => n + 1);
      });
    };

    (async () => {
      try {
        setState("starting");

        const info = await fetch("/api/instance").then(res =>
          res.ok ? res.json() : null
        );
        if (cancelled) return;
        if (!info?.capabilities?.clientMatrix) {
          setState("off");
          return;
        }
        setIngests(info?.capabilities?.eventIngest === true);
        setEncryptionAvailable(info?.capabilities?.e2ee === true);

        const stored = localStorage.getItem(DEVICE_ID_KEY) ?? undefined;
        const credentials = await clientSessionRef.current.mutateAsync({
          deviceId: stored,
          displayName: deviceDisplayName(),
        });
        if (cancelled) return;
        localStorage.setItem(DEVICE_ID_KEY, credentials.deviceId);

        // Everything expensive is behind this line.
        const { startCryptoSession } = await import("@/lib/matrixCrypto");
        if (cancelled) return;

        started = await startCryptoSession({
          homeserverUrl: credentials.homeserverUrl,
          userId: credentials.matrixUserId,
          accessToken: credentials.accessToken,
          deviceId: credentials.deviceId,
          completeCrossSigningAuth: async uiaSession => {
            await crossSigningAuthRef.current.mutateAsync({
              session: uiaSession,
            });
          },
          onChange: bump,
          onVerificationRequest: request => {
            if (!cancelled) setPendingVerification(request);
          },
          onTimelineEvent: event => onEventRef.current(event),
        });

        if (cancelled) {
          await started.stop();
          return;
        }

        sessionRef.current = started;
        setSession(started);
        setState("live");
      } catch {
        // A homeserver that didn't answer, a revoked device, a WASM that
        // wouldn't load: all of them mean the same thing to the caller, which
        // is that the polling fallback is still doing its job.
        if (!cancelled) setState("error");
      }
    })();

    return () => {
      cancelled = true;
      const running = started ?? sessionRef.current;
      sessionRef.current = null;
      setSession(null);
      setPendingVerification(null);
      setState("off");
      setIngests(false);
      void running?.stop();
    };
  }, [enabled]);

  const send = useCallback(async (roomId: string, body: string) => {
    const running = sessionRef.current;
    if (!running) throw new Error("No direct Matrix session");
    return await running.send(roomId, body);
  }, []);

  const lookup = useCallback(
    (eventId: string) => sessionRef.current?.lookup(eventId),
    // `revision` is not read here, but a lookup made before it changed can be
    // stale; depending on it gives callers a new function identity to memo on.
    [revision]
  );

  const backfill = useCallback(async (roomId: string) => {
    await sessionRef.current?.backfill(roomId);
  }, []);

  const sendFile = useCallback(
    async (roomId: string, file: FileAnnouncement) => {
      const running = sessionRef.current;
      if (!running) throw new Error("No direct Matrix session");
      return await running.sendFile(roomId, file);
    },
    []
  );

  const attachmentFor = useCallback(
    (cid: string) => sessionRef.current?.attachmentFor(cid),
    // Same reasoning as `lookup`: the answer changes when the session does.
    [revision]
  );

  const clearPendingVerification = useCallback(
    () => setPendingVerification(null),
    []
  );

  // Re-read readiness whenever the session reports a change: verifying a
  // device, restoring a backup and turning key backup on all resolve it, and
  // all of them happen without a re-mount.
  useEffect(() => {
    if (!session) {
      setCryptoReady(null);
      return;
    }
    let cancelled = false;
    void session
      .readiness()
      .then(result => {
        if (!cancelled) setCryptoReady(result.verdict.level === "ready");
      })
      .catch(() => {
        if (!cancelled) setCryptoReady(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session, revision]);

  const live = state === "live";

  return {
    live,
    state,
    canAuthor: live && ingests,
    encryptionAvailable,
    session,
    cryptoReady,
    revision,
    pendingVerification,
    clearPendingVerification,
    send,
    lookup,
    backfill,
    sendFile,
    attachmentFor,
  };
}
