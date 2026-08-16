import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ConnectionManager,
  memoryConnectionStore,
  webConnectionStore,
  type Connection,
} from "@shared/connections";
import { serverBaseUrl } from "@shared/invite";
import type { DeepLinkAction } from "@shared/deeplink";
import {
  deepLinks,
  showServer,
  startListeningForDeepLinks,
  webviewLabel,
} from "@/lib/bridge";
import AddServer from "@/components/AddServer";
import FirstRun from "@/components/FirstRun";
import Rail from "@/components/Rail";
import SignIn from "@/components/SignIn";
import UpdatePrompt from "@/components/UpdatePrompt";
import { appVersion, credentials } from "@/lib/bridge";

const IDENTITY_URL = "https://sovrgnnet.cc";

/**
 * The desktop shell.
 *
 * This window is a frame: a rail down the left listing every server you're
 * connected to, and a region on the right where the selected server's own
 * interface is shown in its own webview.
 *
 * Loading each server's own UI means the client works against servers older
 * than itself — a property worth keeping until encryption keys have to move
 * into the client (see ADR 0001, step 4), at which point this becomes a
 * native UI talking to each server's API directly.
 */

function createStore() {
  try {
    if (window.localStorage) return webConnectionStore(window.localStorage);
  } catch {
    /* storage unavailable */
  }
  return memoryConnectionStore();
}

export default function App() {
  const manager = useMemo(() => new ConnectionManager(createStore()), []);

  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  // Held in a ref as well as state so the deep-link handler — which is
  // registered once — always sees the current list rather than a stale
  // closure from first render.
  const connectionsRef = useRef<Connection[]>([]);
  connectionsRef.current = connections;

  const reload = useCallback(async () => {
    const list = await manager.list();
    setConnections(list);
    return list;
  }, [manager]);

  const open = useCallback(async (connection: Connection) => {
    setActiveId(connection.id);
    await showServer(serverBaseUrl(connection), webviewLabel(connection.id));
  }, []);

  /**
   * After signing in, add the servers this account has previously used.
   *
   * The identity provider records a grant per server someone signed into, so
   * a new computer can pick up where the last one left off. Servers that
   * can't be reached are skipped quietly rather than failing the sign-in —
   * a friend's machine being off shouldn't look like a broken login.
   */
  const adoptServersFrom = useCallback(
    async (sessionToken: string) => {
      try {
        await credentials.store("sovrgnnet.cc", sessionToken);

        const res = await fetch(`${IDENTITY_URL}/api/grants`, {
          headers: { Authorization: `Bearer ${sessionToken}` },
        });
        if (!res.ok) throw new Error(`Couldn't read your servers (${res.status})`);

        const grants = (await res.json()) as Array<{
          instanceName?: string | null;
          address?: string | null;
          revoked?: boolean;
        }>;

        let added = 0;
        for (const grant of grants) {
          if (grant.revoked || !grant.address) continue;
          try {
            await manager.connect(grant.address);
            added += 1;
          } catch {
            // Unreachable right now; it stays out of the rail until added
            // manually. Not worth failing the whole sign-in over.
          }
        }

        const list = await reload();
        if (list.length > 0) await open(list[0]);

        setNotice(
          added > 0
            ? `Signed in — added ${added} server${added === 1 ? "" : "s"}.`
            : "Signed in. You're not in any servers yet — add one to get started."
        );
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Signed in, but couldn't load servers.");
      }
    },
    [manager, reload, open]
  );

  useEffect(() => {
    void (async () => {
      await startListeningForDeepLinks();
      // Asked for on launch: the app bundles components whose security fixes
      // are ours to ship, so a version nobody installs is a fix nobody gets.
      appVersion().then(setVersion).catch(() => setVersion(null));
      const list = await reload();
      if (list.length > 0) await open(list[0]);
      setReady(true);
    })();
  }, [reload, open]);

  // Refresh names and reachability on launch, quietly. A server that's off
  // stays in the list — a friend's machine being asleep isn't a reason to
  // forget their community.
  useEffect(() => {
    if (!ready) return;
    void manager.refreshAll().then(() => reload());
  }, [ready, manager, reload]);

  useEffect(() => {
    return deepLinks.onLink(async (action: DeepLinkAction) => {
      try {
        if (action.kind === "invite") {
          const { connection } = await manager.connectFromInvite(
            `sovrgn://invite/${action.invite.host}/${action.invite.code}`
          );
          await reload();
          await open(connection);
          setNotice(`Opened ${connection.name} — accept the invite to join.`);
          return;
        }

        if (action.kind === "server") {
          const known = connectionsRef.current.find(c => c.host === action.host);
          const connection =
            known ?? (await manager.connect(serverBaseUrl(action)));
          await reload();
          await open(connection);
          return;
        }

        setNotice(`That link didn't make sense: ${action.raw}`);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : "Couldn't open that link");
      }
    });
  }, [manager, reload, open]);

  const active = connections.find(c => c.id === activeId) ?? null;

  return (
    <div className="shell">
      <Rail
        connections={connections}
        activeId={activeId}
        onSelect={connection => void open(connection)}
        onAdd={() => setAddOpen(true)}
      />

      <main className="stage">
        {/* The webview the shell creates sits over this region. What shows
            through is only ever the empty state. */}
        {connections.length === 0 && ready && !signingIn && (
          <FirstRun
            onAddServer={() => setAddOpen(true)}
            onSignIn={() => setSigningIn(true)}
          />
        )}

        {signingIn && (
          <SignIn
            identityUrl={IDENTITY_URL}
            onCancel={() => setSigningIn(false)}
            onSignedIn={async token => {
              setSigningIn(false);
              await adoptServersFrom(token);
            }}
          />
        )}

        {active && (
          <div className="stage-header">
            <span className="stage-name">{active.name}</span>
            <span className="stage-host">{active.host}</span>
            {!active.encryption && (
              <span className="stage-warn" title="Messages are readable by whoever runs this server">
                not encrypted
              </span>
            )}
          </div>
        )}
      </main>

      {version && <UpdatePrompt currentVersion={version} />}

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button onClick={() => setNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <AddServer
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onAdded={async connection => {
          await reload();
          await open(connection);
          setAddOpen(false);
        }}
        manager={manager}
      />
    </div>
  );
}
