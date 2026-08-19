import { useEffect, useRef, useState } from "react";
import { INSTALL_STEPS, installProgress, type HostState } from "@shared/hosting";
import {
  hostAvailable,
  hostInstall,
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
        onStarted(started.url);
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
        onStarted(started.url);
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

        {busy === null && (state.status === "running" || state.status === "degraded") && (
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
            {/* The setup code, because this app is the only thing that has it.
                The sign-up screen asks for one and, being the ordinary web
                client, tells people it "was printed when it was installed and
                is in its .env" — true of a server somebody installed in a
                terminal, and true of nothing here. There is no terminal and no
                file anyone is going to find.

                Shown only while the server is running and only until the first
                account exists, which is exactly when it is needed and useful
                to nobody afterwards. */}
            {setupCode && (
              <div className="panel-setup-code">
                <p>
                  Creating the first account needs this setup code. It makes
                  that account the administrator, and stops mattering once it
                  exists.
                </p>
                <code>{setupCode}</code>
                <button
                  className="ghost"
                  onClick={() => void navigator.clipboard.writeText(setupCode)}
                >
                  Copy
                </button>
              </div>
            )}
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
