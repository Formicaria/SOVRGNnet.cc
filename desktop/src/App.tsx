import { IDENTITY_ORIGIN } from "@shared/identity";
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
import HostPanel from "@/components/HostPanel";
import InstancePanel from "@/components/InstancePanel";
import Rail from "@/components/Rail";
import SignIn from "@/components/SignIn";
import UpdatePrompt from "@/components/UpdatePrompt";
import { appVersion, credentials } from "@/lib/bridge";
import { hostAvailable, hostStart, onHostState } from "@/lib/hosting";
import type { HostState } from "@shared/hosting";

/**
 * Where this build looks for the identity service.
 *
 * Overridable at build time so a fork, a self-hosted identity service, or a
 * staging deployment doesn't require patching source. ADR 0003 makes the
 * identity service optional infrastructure; a hardcoded origin with no way past
 * it would contradict that.
 *
 * The default is not currently running anything — see IDENTITY_ORIGIN.
 */
const IDENTITY_URL =
  (import.meta.env.VITE_IDENTITY_URL as string | undefined)?.trim() ||
  IDENTITY_ORIGIN;

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
  const [panelOpen, setPanelOpen] = useState(false);
  const [hostOpen, setHostOpen] = useState(false);
  const [canHost, setCanHost] = useState(false);
  const [host, setHost] = useState<HostState>({ status: "absent" });

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

        // `instanceUrl`, not `address`. This read `grant.address` for its whole
        // life and the API has never sent a field by that name — so the guard
        // below skipped every grant, `added` stayed 0, and "sign in to bring
        // your servers with you" quietly brought nothing. Declaring it
        // optional is what hid it: an optional property the server never sends
        // typechecks perfectly and is always undefined.
        const grants = (await res.json()) as Array<{
          instanceName?: string | null;
          instanceUrl?: string | null;
          revoked?: boolean;
        }>;

        let added = 0;
        for (const grant of grants) {
          // Null instanceUrl means the identity service has only ever seen this
          // instance through the API token flow and has no address it resolved
          // itself. Nothing to connect to, and guessing is not on the table.
          if (grant.revoked || !grant.instanceUrl) continue;
          try {
            await manager.connect(grant.instanceUrl);
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

  /** The hosted server is a connection like any other once it answers. */
  const adoptHostedServer = useCallback(
    async (url: string) => {
      try {
        const connection = await manager.connect(url);
        await reload();
        await open(connection);
      } catch {
        // It answered a moment ago; a race here resolves on the next refresh.
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

      // A machine that hosts starts its server with the app, without being
      // asked each time — that's what "your server" means. A machine that
      // doesn't host notices nothing.
      try {
        const availability = await hostAvailable();
        setCanHost(availability.bundled);
        if (availability.bundled && availability.installed) {
          const started = await hostStart();
          setHost(started);
          if (started.status === "running" || started.status === "degraded") {
            await adoptHostedServer(started.url);
          }
        }
      } catch {
        setCanHost(false);
      }
    })();
  }, [reload, open, adoptHostedServer]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void onHostState(setHost).then(fn => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, []);

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
            canHost={canHost}
            onHost={() => setHostOpen(true)}
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
            {/* Reachable from the frame rather than from inside the instance's
                own interface, because the case it exists for is that interface
                failing to load at all. */}
            <button
              className="stage-info"
              onClick={() => setPanelOpen(true)}
              title="Instance status and capabilities"
            >
              Status
            </button>
          </div>
        )}
      </main>

      <InstancePanel
        connection={active}
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
      />

      <HostPanel
        open={hostOpen}
        state={host}
        onClose={() => setHostOpen(false)}
        onStarted={async url => {
          setHostOpen(false);
          setNotice("Your server is running.");
          await adoptHostedServer(url);
        }}
        onStopped={() => {
          setHost({ status: "stopped", components: [] });
          setNotice("Your server is stopped. It starts again with the app.");
        }}
      />

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
