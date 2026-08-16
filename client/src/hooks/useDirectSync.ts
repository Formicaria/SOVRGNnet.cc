import { useEffect, useRef, useState } from "react";
import {
  createSyncEngine,
  type SyncEngine,
  type SyncEvent,
  type SyncState,
} from "@shared/matrixSyncCore";
import { trpc } from "@/lib/trpc";

/**
 * Live updates over the client's own Matrix session — ADR 0008 stage 3.
 *
 * Asks the instance whether it advertises `clientMatrix`; if so, obtains a
 * device-scoped session and long-polls /sync, calling `onEvent` for each room
 * timeline event. If not — or if anything in the chain fails — `live` stays
 * false and the caller keeps its polling fallback. Degrading quietly is the
 * point: an instance behind loopback is a legitimate deployment, not an error.
 *
 * The deviceId is remembered per browser so reloads replace the same session
 * on the homeserver instead of minting an anonymous new device each time —
 * which is exactly the pile-up stage 1 existed to stop. The access token is
 * deliberately NOT persisted: it lives in memory for the tab's lifetime, and a
 * reload re-mints one over the authenticated instance API.
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
  return os ? `SOVRGNnet web · ${browser} on ${os}` : `SOVRGNnet web · ${browser}`;
}

export interface DirectSyncResult {
  /** True while a /sync stream is delivering events. */
  live: boolean;
  state: SyncState | "unavailable";
  /**
   * True when this client may author events over its own session: the stream
   * is live AND the instance records homeserver pushes (ADR 0009). Without
   * the second half, a directly-sent message would be invisible to every
   * member on the API fallback.
   */
  canAuthor: boolean;
  /** Send m.text over the client's own session. Throws when it can't. */
  sendText: (roomId: string, body: string) => Promise<string>;
}

export function useDirectSync(
  enabled: boolean,
  onEvent: (event: SyncEvent) => void
): DirectSyncResult {
  const [state, setState] = useState<SyncState | "unavailable">("unavailable");
  const [ingests, setIngests] = useState(false);
  const engineRef = useRef<SyncEngine | null>(null);
  const sessionRef = useRef<{ baseUrl: string; accessToken: string } | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const clientSession = trpc.matrix.clientSession.useMutation();
  // The mutation object is stable enough for our purposes but not
  // referentially stable across renders; keep the latest in a ref so the
  // effect below depends only on `enabled`.
  const clientSessionRef = useRef(clientSession);
  clientSessionRef.current = clientSession;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;

    (async () => {
      try {
        const info = await fetch("/api/instance").then(res =>
          res.ok ? res.json() : null
        );
        if (cancelled || !info?.capabilities?.clientMatrix) return;
        setIngests(info?.capabilities?.eventIngest === true);

        const stored = localStorage.getItem(DEVICE_ID_KEY) ?? undefined;
        const session = await clientSessionRef.current.mutateAsync({
          deviceId: stored,
          displayName: deviceDisplayName(),
        });
        if (cancelled) return;

        localStorage.setItem(DEVICE_ID_KEY, session.deviceId);
        sessionRef.current = {
          baseUrl: session.homeserverUrl,
          accessToken: session.accessToken,
        };

        engineRef.current = createSyncEngine({
          baseUrl: session.homeserverUrl,
          accessToken: session.accessToken,
          onEvent: event => onEventRef.current(event),
          onStateChange: next => {
            if (!cancelled) setState(next);
          },
        });
      } catch {
        // Any failure means the polling fallback carries on; the instance
        // works either way and there is nothing for the user to act on.
        if (!cancelled) setState("unavailable");
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.stop();
      engineRef.current = null;
      sessionRef.current = null;
      setState("unavailable");
      setIngests(false);
    };
  }, [enabled]);

  const live = state === "live";

  const sendText = async (roomId: string, body: string): Promise<string> => {
    const session = sessionRef.current;
    if (!session) throw new Error("No direct Matrix session");
    const txnId = `sovrgn_web_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const response = await fetch(
      `${session.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${session.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ msgtype: "m.text", body }),
      }
    );
    if (!response.ok) throw new Error(`send failed (${response.status})`);
    const data = (await response.json()) as { event_id?: string };
    if (!data.event_id) throw new Error("send returned no event id");
    return data.event_id;
  };

  return { live, state, canAuthor: live && ingests, sendText };
}
