import { parseInvite, serverBaseUrl, type ParsedInvite } from "./invite";

/**
 * The set of servers this client is connected to.
 *
 * A SOVRGNnet client is a client for *many* servers — Zach's LXC, a friend's
 * box, a community VPS — the way a mail client holds several accounts. This
 * module owns that list: adding a server, remembering it, ordering it, and
 * checking whether a given address is actually a SOVRGNnet server before
 * anyone types a password into it.
 *
 * It deliberately knows nothing about *sessions*. Credentials live in the
 * platform's secure storage (an OS keychain on desktop, a cookie on web);
 * this is the address book, not the keyring.
 *
 * Storage and fetch are both injected so the same logic runs in a browser, in
 * Tauri, and in tests without touching a real network or a real disk.
 */

export type InstanceInfo = {
  product: string;
  apiVersion: number;
  id: string;
  name: string;
  description: string | null;
  matrixServerName: string;
  matrixBaseUrl: string | null;
  joinPolicy: "open" | "invite" | "closed";
  encryption: boolean;
  listed: boolean;
  software: { name: string; version: string };
};

export type Connection = {
  /** The instance's own stable id — the identity we de-duplicate on. */
  id: string;
  host: string;
  secure: boolean;
  name: string;
  /** Last known metadata, refreshed on connect. May be stale; never trusted for auth. */
  matrixServerName: string;
  encryption: boolean;
  /** Millisecond timestamp of the last successful probe. */
  lastSeen: number;
  /** User's ordering in the rail. */
  order: number;
};

export interface ConnectionStore {
  read(): Promise<Connection[]>;
  write(connections: Connection[]): Promise<void>;
}

/** The highest apiVersion this client understands. */
export const SUPPORTED_API_VERSION = 1;

export class NotASovrgnServer extends Error {
  constructor(public readonly host: string) {
    super(`${host} doesn't look like a SOVRGNnet server`);
    this.name = "NotASovrgnServer";
  }
}

export class ServerTooNew extends Error {
  constructor(public readonly host: string, public readonly apiVersion: number) {
    super(`${host} speaks a newer protocol (v${apiVersion}) — update this client`);
    this.name = "ServerTooNew";
  }
}

type FetchLike = typeof fetch;

/**
 * Ask a host what it is.
 *
 * Called before any login screen is shown, so that pointing the client at a
 * typo'd address produces "that isn't a SOVRGNnet server" rather than a
 * password prompt on someone else's website.
 */
export async function probeInstance(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 8000
): Promise<InstanceInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let info: unknown;
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/instance`, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new NotASovrgnServer(baseUrl);
    info = await res.json();
  } catch (err) {
    if (err instanceof NotASovrgnServer) throw err;
    throw new NotASovrgnServer(baseUrl);
  } finally {
    clearTimeout(timer);
  }

  const candidate = info as Partial<InstanceInfo>;
  if (candidate?.product !== "sovrgnnet" || typeof candidate.id !== "string") {
    throw new NotASovrgnServer(baseUrl);
  }
  if (typeof candidate.apiVersion === "number" && candidate.apiVersion > SUPPORTED_API_VERSION) {
    // Failing loudly beats guessing at a payload we don't understand.
    throw new ServerTooNew(baseUrl, candidate.apiVersion);
  }

  return candidate as InstanceInfo;
}

export class ConnectionManager {
  constructor(
    private readonly store: ConnectionStore,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async list(): Promise<Connection[]> {
    const connections = await this.store.read();
    return [...connections].sort((a, b) => a.order - b.order);
  }

  /**
   * Add a server by address, or update it if it's already known.
   *
   * De-duplication is by instance id, not by host: the same server reached at
   * `192.168.1.50:3000` and later at `chat.example.com` is one server, and
   * adding it twice would put it in the rail twice.
   */
  async connect(hostOrUrl: string): Promise<Connection> {
    const { host, secure } = normalizeHost(hostOrUrl);
    const info = await probeInstance(serverBaseUrl({ host, secure }), this.fetchImpl);

    const existing = await this.store.read();
    const previous = existing.find(c => c.id === info.id);

    const connection: Connection = {
      id: info.id,
      host,
      secure,
      name: info.name,
      matrixServerName: info.matrixServerName,
      encryption: info.encryption,
      lastSeen: Date.now(),
      order: previous?.order ?? nextOrder(existing),
    };

    await this.store.write([...existing.filter(c => c.id !== info.id), connection]);
    return connection;
  }

  /** Add the server an invite points at, without consuming the invite. */
  async connectFromInvite(
    invite: string,
    fallbackHost?: string
  ): Promise<{ connection: Connection; parsed: ParsedInvite }> {
    const parsed = parseInvite(invite, fallbackHost);
    if (!parsed) throw new Error("That doesn't look like an invite link");
    const connection = await this.connect(serverBaseUrl(parsed));
    return { connection, parsed };
  }

  async disconnect(id: string): Promise<void> {
    const existing = await this.store.read();
    await this.store.write(existing.filter(c => c.id !== id));
  }

  /** Persist a new rail order, given ids in the order the user arranged them. */
  async reorder(idsInOrder: string[]): Promise<Connection[]> {
    const existing = await this.store.read();
    const ranked = new Map(idsInOrder.map((id, index) => [id, index]));
    const updated = existing.map(c => ({
      ...c,
      // Anything not mentioned keeps its place at the end rather than
      // silently jumping to the front.
      order: ranked.get(c.id) ?? idsInOrder.length + c.order,
    }));
    await this.store.write(updated);
    return [...updated].sort((a, b) => a.order - b.order);
  }

  /**
   * Re-probe every known server, refreshing names and reachability.
   *
   * A server that fails to answer is kept, not dropped — a laptop being shut
   * for the night shouldn't erase a community from someone's client.
   */
  async refreshAll(): Promise<Array<{ connection: Connection; reachable: boolean }>> {
    const existing = await this.list();
    const results = await Promise.all(
      existing.map(async connection => {
        try {
          const info = await probeInstance(serverBaseUrl(connection), this.fetchImpl);
          return {
            connection: {
              ...connection,
              name: info.name,
              matrixServerName: info.matrixServerName,
              encryption: info.encryption,
              lastSeen: Date.now(),
            },
            reachable: true,
          };
        } catch {
          return { connection, reachable: false };
        }
      })
    );
    await this.store.write(results.map(r => r.connection));
    return results;
  }
}

function nextOrder(connections: Connection[]): number {
  return connections.reduce((max, c) => Math.max(max, c.order), -1) + 1;
}

/** Accept a bare host, a host:port, or a full URL; return host + scheme. */
export function normalizeHost(input: string): { host: string; secure: boolean } {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Enter a server address");

  const withScheme = trimmed.includes("://") ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`"${input}" isn't a valid server address`);
  }
  if (!url.host) throw new Error(`"${input}" isn't a valid server address`);

  return { host: url.host, secure: url.protocol !== "http:" };
}

/** A ConnectionStore over any Web Storage implementation. */
export function webConnectionStore(
  storage: Pick<Storage, "getItem" | "setItem">,
  key = "sovrgnnet.connections"
): ConnectionStore {
  return {
    async read() {
      try {
        const raw = storage.getItem(key);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? (parsed as Connection[]) : [];
      } catch {
        // A corrupt address book shouldn't prevent the app from starting.
        return [];
      }
    },
    async write(connections) {
      storage.setItem(key, JSON.stringify(connections));
    },
  };
}

/** An in-memory ConnectionStore, for tests and for ephemeral sessions. */
export function memoryConnectionStore(initial: Connection[] = []): ConnectionStore {
  let state = [...initial];
  return {
    async read() {
      return [...state];
    },
    async write(connections) {
      state = [...connections];
    },
  };
}
