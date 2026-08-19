import { useEffect, useRef, useState } from "react";
import { INSTALL_STEPS, installProgress, type HostState } from "@shared/hosting";
import {
  createFirstAccount,
  hostAvailable,
  hostInstall,
  hostNeedsFirstAccount,
  hostSecrets,
  hostStart,
  hostStop,
  onInstallStep,
} from "@/lib/hosting";

/**
 * Running a server on this computer.
 *
 * The audience is someone who has never hosted anything: every state says
 * what is happening in words, install progress names its step, and a failure
 * shows the component's own words rather than a code. Once the server runs,
 * it appears in the rail like any other — its settings live in its own
 * interface, exactly as they would for a server across the world.
 */
export default function HostPanel({
  open,
  state,
  onClose,
  onStarted,
  onStopped,
}: {
  open: boolean;
  state: HostState;
  onClose: () => void;
  /** The server is up at this address — connect and show it. */
  onStarted: (url: string) => void;
  onStopped: () => void;
}) {
  const [bundled, setBundled] = useState<boolean | null>(null);
  const [setupCode, setSetupCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<"install" | "start" | "stop" | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server is up but has no accounts yet: the very next thing is the
  // form below, and the panel stays open until it's done. This used to close
  // the panel and show a setup code instead — leaving the person at a
  // sign-up form demanding a code whose only display had just closed.
  const [accountUrl, setAccountUrl] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) return;
    void hostAvailable().then(a => setBundled(a.bundled)).catch(() => setBundled(false));
  }, [open]);

  // Read from the keychain rather than held anywhere. Failing quietly is
  // right: not knowing the code is a worse panel, not a broken one, and the
  // server runs fine either way.
  useEffect(() => {
    if (!open) return;
    void hostSecrets()
      .then(secrets => setSetupCode(secrets.setup_token || null))
      .catch(() => setSetupCode(null));
  }, [open]);

  useEffect(() => {
    return () => unlisten.current?.();
  }, []);

  if (!open) return null;

  // The server is up. If it has no accounts yet, the panel's job isn't done:
  // creating the first one — the administrator — happens right here, with
  // the token this app already holds. Only then does the server open.
  const handOff = async (url: string) => {
    if (await hostNeedsFirstAccount(url)) {
      setAccountUrl(url);
    } else {
      onStarted(url);
    }
  };

  const createAccount = async () => {
    if (!accountUrl) return;
    setError(null);
    setCreating(true);
    try {
      await createFirstAccount(accountUrl, { username, password });
      const url = accountUrl;
      setAccountUrl(null);
      setPassword("");
      onStarted(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  };

  const installAndStart = async () => {
    setError(null);
    setBusy("install");
    try {
      unlisten.current = await onInstallStep(setStep);
    } catch {
      /* progress without step names still progresses */
    }
    try {
      await hostInstall();
      setBusy("start");
      const started = await hostStart();
      if (started.status === "running" || started.status === "degraded") {
        await handOff(started.url);
      } else if (started.status === "failed") {
        setError(started.problem);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
      setStep(null);
      unlisten.current?.();
      unlisten.current = null;
    }
  };

  const start = async () => {
    setError(null);
    setBusy("start");
    try {
      const started = await hostStart();
      if (started.status === "running" || started.status === "degraded") {
        await handOff(started.url);
      } else if (started.status === "failed") {
        setError(started.problem);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setError(null);
    setBusy("stop");
    try {
      await hostStop();
      onStopped();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const progress = step ? installProgress(step) : null;
  const stepLabel = step ? INSTALL_STEPS.find(s => s.id === step)?.label : null;

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside className="panel" onClick={event => event.stopPropagation()}>
        <header className="panel-head">
          <h2>Your server</h2>
          <button className="panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {bundled === false && (
          <p className="dim">
            This build ships without the server components — the AppImage and
            development builds are like this. To host from the desktop, use
            the .deb or Windows installer from sovrgnnet.cc; to host without
            it, any Linux box and one command — the install guide covers both.
          </p>
        )}

        {error && <p className="error">{error}</p>}

        {bundled && state.status === "absent" && busy === null && (
          <>
            <p>
              Run a SOVRGNnet server on this computer. Your messages stay on
              your machine; friends on your network can join with an invite.
            </p>
            <p className="dim">
              Sets up a database, a chat server, file storage, and a voice
              server — a few hundred megabytes on disk, all under your user
              account, nothing needing an administrator. The server runs while
              the app is open.
            </p>
            <button className="primary" onClick={() => void installAndStart()}>
              Set up my server
            </button>
          </>
        )}

        {busy === "install" && (
          <>
            <p>Setting up…</p>
            {progress && (
              <p className="dim">
                {stepLabel ?? "Working"} ({progress.completed}/{progress.total})
              </p>
            )}
          </>
        )}
        {busy === "start" && <p>Starting your server…</p>}
        {busy === "stop" && <p>Stopping…</p>}

        {/* The server is running and waiting for its first account. This
            form spends the setup token the app already holds — hostSecrets,
            same keychain entry the server was started with — so nobody
            transcribes a code between two panes of one program. The panel
            used to close itself here and show the code instead; a fresh
            Windows install walked straight into a sign-up form demanding a
            code whose only display had just closed. The server-side guard is
            unchanged: strangers over the network still need the token, and
            this is its owner using it. */}
        {busy === null && accountUrl && (
          <>
            <p>
              Your server is running. Create your account — the first one
              becomes its administrator.
            </p>
            <input
              placeholder="Username"
              value={username}
              autoFocus
              onChange={event => setUsername(event.target.value)}
              disabled={creating}
            />
            <input
              type="password"
              placeholder="Password (8 characters or more)"
              value={password}
              onChange={event => setPassword(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") void createAccount();
              }}
              disabled={creating}
            />
            <button
              className="primary"
              onClick={() => void createAccount()}
              disabled={creating || username.trim().length === 0 || password.length < 8}
            >
              {creating ? "Creating…" : "Create my account"}
            </button>
            {/* The code survives only as the fallback for someone who'd
                rather do this from another device's browser — that sign-up
                form asks for it, and this app is the only thing that has it. */}
            {setupCode && (
              <p className="dim">
                Setting up from another device instead? Its sign-up form will
                ask for this setup code:{" "}
                <code>{setupCode}</code>{" "}
                <button
                  className="linky inline"
                  onClick={() => void navigator.clipboard.writeText(setupCode)}
                >
                  copy
                </button>
              </p>
            )}
          </>
        )}

        {busy === null &&
          !accountUrl &&
          (state.status === "running" || state.status === "degraded") && (
          <>
            <p>
              Your server is running at <code>{state.url}</code>.
            </p>
            {state.status === "degraded" && <p className="warn-inline">{state.problem}</p>}
            <ul className="panel-deps">
              {state.components.map(component => (
                <li key={component.id} className={component.state === "running" ? "up" : "down"}>
                  <span className="panel-dep-name">{component.id}</span>
                  <span className="panel-dep-state">
                    {component.state}
                    {component.port ? ` · :${component.port}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            <p className="dim">
              It stops when the app quits. Settings, invites, and members are
              managed inside the server itself — select it in the rail.
            </p>
            <button className="ghost" onClick={() => void stop()}>
              Stop the server
            </button>
          </>
        )}

        {busy === null && state.status === "starting" && (
          <p className="dim">Starting — waiting for the components to answer…</p>
        )}

        {busy === null && state.status === "stopped" && (
          <>
            <p>Your server is installed but not running.</p>
            <button className="primary" onClick={() => void start()}>
              Start it
            </button>
          </>
        )}

        {busy === null && state.status === "failed" && (
          <>
            <p className="error">{state.problem}</p>
            <p className="dim">
              The component logs live in the app's data folder under{" "}
              <code>host/logs/</code> — the last lines usually say what went
              wrong.
            </p>
            <button className="primary" onClick={() => void start()}>
              Try again
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
