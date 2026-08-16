/**
 * A minimal Matrix /sync engine — the transport half of ADR 0008 stage 3.
 *
 * Hand-rolled rather than matrix-js-sdk because the client needs exactly one
 * thing from sync at this stage: "something happened in room X, go refetch".
 * The SDK brings a crypto store, an event graph, and a megabyte of code the
 * bundle would carry for a notification bell. When stage 4 (E2EE) lands the
 * SDK earns its place; until then this is reviewable in one sitting.
 *
 * Dependency-free and fetch-injectable so it unit-tests without a homeserver
 * and runs identically in the browser and the desktop shell.
 */

export interface SyncEvent {
  roomId: string;
  type: string;
  eventId: string;
  sender: string;
  originServerTs: number;
  content: Record<string, unknown>;
}

export type SyncState =
  | "starting"   // first request in flight
  | "live"       // long-polling, events flowing
  | "reconnecting" // transient failure, backing off
  | "stopped"    // stop() called, or fatal
  ;

export interface SyncEngineOptions {
  /** Homeserver base URL, no trailing slash — e.g. https://matrix.example.com */
  baseUrl: string;
  accessToken: string;
  onEvent: (event: SyncEvent) => void;
  onStateChange?: (state: SyncState, detail?: string) => void;
  /** Test seam; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Long-poll timeout the homeserver holds the request open for. */
  timeoutMs?: number;
  /** Cap for the reconnect backoff. */
  maxBackoffMs?: number;
}

/**
 * The filter keeps the stream lean: recent timeline only, no presence, no
 * ephemeral events, no account data. History belongs to the instance API;
 * sync's job here is liveness.
 */
const SYNC_FILTER = JSON.stringify({
  room: {
    timeline: { limit: 20 },
    ephemeral: { types: [] },
    account_data: { types: [] },
  },
  presence: { types: [] },
  account_data: { types: [] },
});

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: Array<{
            type?: string;
            event_id?: string;
            sender?: string;
            origin_server_ts?: number;
            content?: Record<string, unknown>;
          }>;
        };
      }
    >;
  };
}

export interface SyncEngine {
  stop(): void;
  readonly state: SyncState;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBackoffMs = options.maxBackoffMs ?? 15_000;

  let state: SyncState = "starting";
  let stopped = false;
  let controller: AbortController | null = null;
  let since: string | null = null;
  let backoffMs = 1_000;

  const setState = (next: SyncState, detail?: string) => {
    if (state === next) return;
    state = next;
    options.onStateChange?.(next, detail);
  };

  const url = (params: Record<string, string>) => {
    const query = new URLSearchParams(params).toString();
    return `${options.baseUrl}/_matrix/client/v3/sync?${query}`;
  };

  async function once(): Promise<void> {
    controller = new AbortController();

    // The first request establishes a position without replaying history —
    // timeout=0 returns immediately and its events are ignored. Everything the
    // user sees as history comes from the instance API; sync starts at "now".
    const initial = since === null;
    const params: Record<string, string> = {
      filter: SYNC_FILTER,
      timeout: initial ? "0" : String(timeoutMs),
    };
    if (since) params.since = since;

    const response = await fetchImpl(url(params), {
      headers: { Authorization: `Bearer ${options.accessToken}` },
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      // The token was revoked — a user signing this device out from their
      // device list does exactly this. Not an error to retry through.
      setState("stopped", "session revoked");
      stopped = true;
      return;
    }
    if (!response.ok) {
      throw new Error(`sync failed (${response.status})`);
    }

    const body = (await response.json()) as SyncResponse;
    if (!body?.next_batch) {
      throw new Error("sync response missing next_batch");
    }

    const emit = !initial;
    since = body.next_batch;
    backoffMs = 1_000;
    setState("live");

    if (!emit) return;

    const joined = body.rooms?.join ?? {};
    for (const [roomId, room] of Object.entries(joined)) {
      for (const event of room.timeline?.events ?? []) {
        if (!event.type || !event.event_id || !event.sender) continue;
        options.onEvent({
          roomId,
          type: event.type,
          eventId: event.event_id,
          sender: event.sender,
          originServerTs: event.origin_server_ts ?? 0,
          content: event.content ?? {},
        });
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await once();
      } catch (err) {
        if (stopped) return;
        setState(
          "reconnecting",
          err instanceof Error ? err.message : "sync error"
        );
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      }
    }
  }

  void loop();

  return {
    stop() {
      stopped = true;
      setState("stopped");
      controller?.abort();
    },
    get state() {
      return state;
    },
  };
}
