import { useEffect, useRef, useState } from "react";
import {
  ACCESS_MODES,
  DEFAULT_HOST_OPTIONS,
  INSTALL_STEPS,
  installProgress,
  type AccessMode,
  type HostOptions,
  type HostState,
} from "@shared/hosting";
import {
  createFirstAccount,
  hostAvailable,
  hostInstall,
  hostNeedsFirstAccount,
  hostOpenLogs,
  hostOptions,
  hostSecrets,
  hostStart,
  hostStop,
  hostUninstall,
  onInstallStep,
  saveHostOptions,
} from "@/lib/hosting";
import AccessChoice from "./AccessChoice";

/**
 * Running a server on this computer.
 *
 * The audience is someone who has never hosted anything: every state says
 * what is happening in words, install progress names its step, and a failure
 * shows the component's own words rather than a code. Once the server runs,
 * it appears in the rail like any other — its settings live in its own
 * interface, exactly as they would for a server across the world.
 *
 * What lives *here* is only what the server cannot do for itself: how it is
 * reached (which is decided before it starts), whether it is running, where
 * its logs are, and how to remove it. Everything about the community —
 * name, who may join, members, voice — is the server's own settings screen,
 * and this panel hands off to it rather than growing a second copy.
 */
export default function HostPanel({
  open,
  state,
  version,
  onClose,
  onStarted,
  onStopped,
  onRemoved,
  onOpenServer,
}: {
  open: boolean;
  state: HostState;
  /**
   * The shell's own version, stamped in the header. Seven relaunches of the
   * first Linux walk probed a stale process because nothing on screen said
   * which build had drawn the window — the panel now says it.
   */
  version?: string | null;
  onClose: () => void;
  /** The server is up at this address — connect and show it. */
  onStarted: (url: string) => void;
  onStopped: () => void;
  /** The server has been removed from this computer entirely. */
  onRemoved: () => void;
  /** Show the running server's own interface (its settings live there). */
  onOpenServer: (url: string) => void;
}) {
  const [bundled, setBundled] = useState<boolean | null>(null);
  const [setupCode, setSetupCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<"install" | "start" | "stop" | "restart" | "remove" | null>(
    null
  );
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

  // The access choice on disk: undefined until read, null when never made.
  // Null is the state the first-run flow hinges on — see `hostOptions`.
  const [options, setOptions] = useState<HostOptions | null | undefined>(undefined);
  // What the person has picked but not yet applied. Separate from `options`
  // so a change of mind before "Continue" costs nothing, and so a change to
  // a running server can say "applies on restart" until it does.
  const [chosen, setChosen] = useState<AccessMode | null>(null);
  const [copied, setCopied] = useState(false);
  // Removal asks for a word, not a click: it deletes every message on the
  // server, and the confirm-dialog reflex is exactly the reflex that would
  // click through it.
  const [removing, setRemoving] = useState(false);
  const [removeWord, setRemoveWord] = useState("");

  useEffect(() => {
    if (!open) return;
    void hostAvailable().then(a => setBundled(a.bundled)).catch(() => setBundled(false));
    void hostOptions()
      .then(o => {
        setOptions(o);
        setChosen(o?.access ?? null);
      })
      .catch(() => setOptions(null));
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

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

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

  /** Persist the access choice; the returned options are what to start with. */
  const commitChoice = async (mode: AccessMode): Promise<HostOptions> => {
    const next: HostOptions = { access: mode };
    await saveHostOptions(next);
    setOptions(next);
    setChosen(mode);
    return next;
  };

  const installAndStart = async (mode: AccessMode) => {
    setError(null);
    setBusy("install");
    try {
      unlisten.current = await onInstallStep(setStep);
    } catch {
      /* progress without step names still progresses */
    }
    try {
      const opts = await commitChoice(mode);
      await hostInstall();
      setBusy("start");
      const started = await hostStart(opts);
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

  const start = async (mode: AccessMode) => {
    setError(null);
    setBusy("start");
    try {
      const opts = await commitChoice(mode);
      const started = await hostStart(opts);
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

  /**
   * Change how the server is reached while it runs.
   *
   * The access mode is read once, at start, because the public hostname has
   * to be in the app's environment before it boots — so a change means a
   * restart, and the panel says so before the button is pressed rather than
   * after the server vanishes. Stop and start rather than a bespoke reload:
   * the sequence people already understand, with the steps already tested.
   */
  const applyAccess = async (mode: AccessMode) => {
    setError(null);
    setBusy("restart");
    try {
      const opts = await commitChoice(mode);
      await hostStop();
      const started = await hostStart(opts);
      if (started.status === "running" || started.status === "degraded") {
        // Not handOff: the server has accounts by now, and closing the panel
        // on a settings change would hide the new public link the person
        // changed the setting to get.
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

  const openLogs = async () => {
    setError(null);
    try {
      await hostOpenLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async () => {
    setError(null);
    setBusy("remove");
    try {
      await hostUninstall();
      setRemoving(false);
      setRemoveWord("");
      setOptions(null);
      setChosen(null);
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* the address is on screen and selectable regardless */
    }
  };

  const progress = step ? installProgress(step) : null;
  const stepLabel = step ? INSTALL_STEPS.find(s => s.id === step)?.label : null;
  const running = state.status === "running" || state.status === "degraded";
  const publicUrl = running ? state.publicUrl : null;
  const tunnel = running ? state.components.find(c => c.id === "tunnel") : undefined;
  const accessLabel = (mode: AccessMode) =>
    ACCESS_MODES.find(m => m.id === mode)?.label ?? mode;
  // A never-asked install (from before the choice existed, or an interrupted
  // first run) must be asked before it starts — that is the whole contract.
  const needsChoice = options === null;
  const pendingChange =
    options != null && chosen != null && chosen !== options.access;

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <aside className="panel" onClick={event => event.stopPropagation()}>
        <header className="panel-head">
          <h2>Your server</h2>
          {version && <span className="panel-version">v{version}</span>}
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

        {/* ---------------------------------------------------- first run */}
        {bundled && state.status === "absent" && busy === null && (
          <>
            <p>
              Run a SOVRGNnet server on this computer. Your messages stay on
              your machine; the people you invite connect to it directly.
            </p>
            <p className="dim">
              Sets up a database, a chat server, file storage, and a voice
              server — a few hundred megabytes on disk, all under your user
              account, nothing needing an administrator. The server runs while
              the app is open.
            </p>
            <div className="panel-section">
              <h3>How should people reach it?</h3>
              <AccessChoice value={chosen} onChange={setChosen} />
              <p className="dim">You can change this later, here.</p>
            </div>
            <button
              className="primary"
              disabled={chosen === null}
              onClick={() => chosen && void installAndStart(chosen)}
            >
              Set up my server
            </button>
          </>
        )}

        {/* ------------------------------ installed, but never asked (v0.8) */}
        {bundled &&
          busy === null &&
          !accountUrl &&
          needsChoice &&
          state.status !== "absent" && (
            <>
              <p>Before your server starts, one question it never got to ask:</p>
              <div className="panel-section">
                <h3>How should people reach it?</h3>
                <AccessChoice value={chosen} onChange={setChosen} />
              </div>
              <button
                className="primary"
                disabled={chosen === null}
                onClick={() => chosen && void start(chosen)}
              >
                Start my server
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
        {busy === "restart" && <p>Restarting with the new setting…</p>}
        {busy === "remove" && <p>Removing your server from this computer…</p>}

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

        {/* ------------------------------------------------------ running */}
        {busy === null && !accountUrl && !needsChoice && running && (
          <>
            <p>
              Your server is running at <code>{state.url}</code>.
            </p>
            {state.status === "degraded" && <p className="warn-inline">{state.problem}</p>}

            {/* The public link, when there is meant to be one. Three
                states, all said in words: it's here, it's on its way, or it
                couldn't happen — and in that last case what the server IS
                still reachable by, so the row never reads as "broken" about
                a server people can use. */}
            {options?.access === "tunnel" && (
              <div className="panel-section">
                <h3>Public link</h3>
                {publicUrl ? (
                  <>
                    <div className="panel-block panel-row">
                      <code className="panel-url">{publicUrl}</code>
                      <button className="ghost small" onClick={() => void copy(publicUrl)}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                    <p className="dim">
                      Anyone with this link can reach your server. It changes
                      each time the server restarts, and invite links you
                      shared before a restart stop working. Invites you create
                      inside the server use this address automatically.
                    </p>
                  </>
                ) : tunnel?.state === "failed" ? (
                  <p className="warn-inline">
                    {tunnel.error ?? "The public link couldn't be created."} Your
                    server is still reachable on your own network.
                  </p>
                ) : (
                  <p className="dim">Getting your public link from Cloudflare…</p>
                )}
              </div>
            )}
            {options?.access === "lan" && (
              <div className="panel-section">
                <h3>Reach</h3>
                <p className="dim">
                  Only people on your network can reach this server. Invite
                  links you create inside it carry your network address.
                </p>
              </div>
            )}

            <div className="panel-section">
              <h3>Components</h3>
              <ul className="panel-deps">
                {state.components.map(component => (
                  <li
                    key={component.id}
                    // "off" is neither up nor down: a deliberately skipped SFU
                    // painted red would say "broken" about a decision. Neutral,
                    // with the reason below. "starting" is the third colour:
                    // a component that is on its way is neither.
                    className={
                      component.state === "running"
                        ? "up"
                        : component.state === "off"
                          ? "off"
                          : component.state === "starting"
                            ? "pending"
                            : "down"
                    }
                  >
                    <span className="panel-dep-name">{component.id}</span>
                    <span className="panel-dep-state">
                      {component.state}
                      {component.port ? ` · :${component.port}` : ""}
                    </span>
                    {/* The words, not just the color — the reason a component
                        is off or failed is the part a person can act on, and
                        the walk that motivated this found only silences. */}
                    {component.error && component.state !== "running" && (
                      <span className="panel-dep-note">{component.error}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <div className="panel-section">
              <h3>Settings</h3>
              <p className="dim">
                Name, who can join, members, roles, voice, storage — all of
                that is managed inside the server itself, where it would be
                for any server.
              </p>
              <div className="panel-actions">
                <button className="ghost" onClick={() => onOpenServer(state.url)}>
                  Open server settings
                </button>
                <button className="ghost" onClick={() => void openLogs()}>
                  Open logs folder
                </button>
              </div>
            </div>

            <div className="panel-section">
              <h3>How people reach it</h3>
              <AccessChoice value={chosen} onChange={setChosen} />
              {pendingChange && chosen && (
                <div className="panel-block">
                  <p className="dim">
                    Switching to <strong>{accessLabel(chosen)}</strong> takes a
                    restart — the server reads this once, as it starts. People
                    connected right now will drop for a few seconds.
                  </p>
                  <div className="panel-actions">
                    <button className="primary" onClick={() => void applyAccess(chosen)}>
                      Restart now
                    </button>
                    <button
                      className="ghost"
                      onClick={() => setChosen(options?.access ?? null)}
                    >
                      Keep it as is
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="panel-section">
              <h3>Running</h3>
              <p className="dim">It stops when the app quits, and starts again with it.</p>
              <button className="ghost" onClick={() => void stop()}>
                Stop the server
              </button>
            </div>
          </>
        )}

        {busy === null && !needsChoice && state.status === "starting" && (
          <p className="dim">Starting — waiting for the components to answer…</p>
        )}

        {/* ------------------------------------------------------ stopped */}
        {busy === null && !needsChoice && state.status === "stopped" && (
          <>
            <p>Your server is installed but not running.</p>
            <div className="panel-section">
              <h3>How people reach it</h3>
              <AccessChoice value={chosen} onChange={setChosen} />
              {pendingChange && chosen && (
                <p className="dim">
                  Will start as <strong>{accessLabel(chosen)}</strong>.
                </p>
              )}
            </div>
            <div className="panel-actions">
              <button
                className="primary"
                disabled={chosen === null}
                onClick={() => chosen && void start(chosen)}
              >
                Start it
              </button>
              <button className="ghost" onClick={() => void openLogs()}>
                Open logs folder
              </button>
            </div>
          </>
        )}

        {/* ------------------------------------------------------- failed */}
        {busy === null && !needsChoice && state.status === "failed" && (
          <>
            <p className="error">{state.problem}</p>
            <p className="dim">
              The component logs usually say what went wrong — the last lines
              are the ones to read.
            </p>
            <div className="panel-actions">
              <button
                className="primary"
                onClick={() => void start(chosen ?? options?.access ?? DEFAULT_HOST_OPTIONS.access)}
              >
                Try again
              </button>
              <button className="ghost" onClick={() => void openLogs()}>
                Open logs folder
              </button>
            </div>
          </>
        )}

        {/* ------------------------------------------------------- remove */}
        {bundled &&
          busy === null &&
          !accountUrl &&
          state.status !== "absent" &&
          (running || state.status === "stopped" || state.status === "failed") && (
            <div className="panel-section panel-danger">
              <h3>Remove</h3>
              {!removing ? (
                <>
                  <p className="dim">
                    Deletes the server and everything on it from this computer:
                    every account, message and file. Nothing is kept anywhere.
                  </p>
                  <button className="danger" onClick={() => setRemoving(true)}>
                    Remove this server from this computer
                  </button>
                </>
              ) : (
                <>
                  <p className="warn-inline">
                    This cannot be undone. Every account, every message, every
                    file, and the server's identity — gone. To continue, type{" "}
                    <code>remove</code>.
                  </p>
                  <input
                    placeholder="remove"
                    value={removeWord}
                    autoFocus
                    onChange={event => setRemoveWord(event.target.value)}
                  />
                  <div className="panel-actions">
                    <button
                      className="danger"
                      disabled={removeWord.trim().toLowerCase() !== "remove"}
                      onClick={() => void remove()}
                    >
                      Remove everything
                    </button>
                    <button
                      className="ghost"
                      onClick={() => {
                        setRemoving(false);
                        setRemoveWord("");
                      }}
                    >
                      Keep it
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
      </aside>
    </div>
  );
}
