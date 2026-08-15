import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  ConnectionManager,
  memoryConnectionStore,
  webConnectionStore,
  type Connection,
} from "@shared/connections";

/**
 * The servers this client knows about.
 *
 * A SOVRGNnet client is a client for many servers. This context owns that
 * list — adding, removing, reordering, refreshing — on top of the platform
 * -agnostic ConnectionManager in shared/.
 *
 * ## What the browser can and cannot do
 *
 * In the desktop client, "connected to four servers" means four live sessions
 * at once. In a browser it cannot: sessions are httpOnly cookies scoped to one
 * origin, and no amount of CORS makes a page at one server authenticate
 * against another.
 *
 * So on the web this is an **address book, not a switchboard**. It remembers
 * the servers you know, and switching to one navigates there — a full page
 * load, a separate session on the other side. That's a real limitation and the
 * UI should say so rather than pretend otherwise. The desktop client replaces
 * the navigation with genuine multiplexing.
 */

type ConnectionsValue = {
  connections: Connection[];
  loading: boolean;
  /** The connection matching the origin this page is served from, if known. */
  current: Connection | null;
  /** Probe an address and remember it. Throws with a readable message. */
  connect: (hostOrUrl: string) => Promise<Connection>;
  connectFromInvite: (invite: string) => Promise<Connection>;
  disconnect: (id: string) => Promise<void>;
  reorder: (idsInOrder: string[]) => Promise<void>;
  refresh: () => Promise<void>;
  /** True when this build can hold several live sessions (desktop only). */
  multiplexes: boolean;
};

const ConnectionsContext = createContext<ConnectionsValue | null>(null);

/** Tauri injects this; its absence means we're an ordinary web page. */
function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createStore() {
  // Server-side rendering and locked-down browsers both need a fallback that
  // works rather than throwing on first access.
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return webConnectionStore(window.localStorage);
    }
  } catch {
    /* storage disabled — fall through */
  }
  return memoryConnectionStore();
}

export function ConnectionsProvider({ children }: { children: ReactNode }) {
  const manager = useMemo(() => new ConnectionManager(createStore()), []);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setConnections(await manager.list());
  }, [manager]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      const known = await manager.list();
      if (cancelled) return;

      // First run on a normal web install: the server serving this page is
      // obviously one you're connected to, so adopt it rather than showing an
      // empty rail and asking the user to type their own address.
      if (known.length === 0 && typeof window !== "undefined") {
        try {
          await manager.connect(window.location.origin);
        } catch {
          // An instance that can't describe itself is still usable through
          // this page; it just won't appear in the list.
        }
      }

      if (!cancelled) {
        setConnections(await manager.list());
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [manager]);

  const current = useMemo(() => {
    if (typeof window === "undefined") return null;
    return connections.find(c => c.host === window.location.host) ?? null;
  }, [connections]);

  const value: ConnectionsValue = {
    connections,
    loading,
    current,
    multiplexes: isDesktop(),
    connect: async hostOrUrl => {
      const connection = await manager.connect(hostOrUrl);
      await reload();
      return connection;
    },
    connectFromInvite: async invite => {
      const { connection } = await manager.connectFromInvite(
        invite,
        typeof window !== "undefined" ? window.location.host : undefined
      );
      await reload();
      return connection;
    },
    disconnect: async id => {
      await manager.disconnect(id);
      await reload();
    },
    reorder: async idsInOrder => {
      setConnections(await manager.reorder(idsInOrder));
    },
    refresh: async () => {
      await manager.refreshAll();
      await reload();
    },
  };

  return (
    <ConnectionsContext.Provider value={value}>{children}</ConnectionsContext.Provider>
  );
}

export function useConnections(): ConnectionsValue {
  const context = useContext(ConnectionsContext);
  if (!context) {
    throw new Error("useConnections must be used inside a ConnectionsProvider");
  }
  return context;
}
