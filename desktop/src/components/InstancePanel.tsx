import { useCallback, useEffect, useState } from "react";
import {
  assessHealth,
  healthLabel,
  type HealthProbe,
  type InstanceHealth,
} from "@shared/instanceHealth";
import type { Connection } from "@shared/connections";
import { openExternal } from "@/lib/bridge";

/**
 * What's going on with this instance.
 *
 * The shell shows each instance's own web UI in a webview, which works well and
 * has one blind spot: when the instance is broken, the webview is blank.
 * Exactly when an operator needs information, they get a white rectangle.
 *
 * This lives outside the webview and talks to the unauthenticated discovery
 * endpoints, so it keeps working when nothing else does — including when the
 * failure is "I can't sign in".
 *
 * Everything requiring authentication — settings, roles, moderation — is
 * already administrable inside the instance's own UI, so duplicating it here
 * would mean two implementations of the same screens drifting apart. This
 * covers the part that genuinely cannot live in there.
 */

const TIMEOUT_MS = 8000;

async function probe(base: string, path: string): Promise<HealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(new URL(path, base).toString(), {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    let body: unknown = null;
    try {
      body = JSON.parse(await response.text());
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: 0,
      body: null,
      error: message.toLowerCase().includes("abort") ? "timed out" : message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

const CAPABILITY_LABELS: Record<string, string> = {
  messaging: "Messaging",
  media: "File sharing",
  e2ee: "End-to-end encryption",
  voice: "Voice",
  federation: "Federation",
  sso: "Single sign-on",
  publicRegistration: "Open registration",
  clientMatrix: "Direct Matrix sync",
  portableBackup: "Portable backups",
};

export default function InstancePanel({
  connection,
  open,
  onClose,
}: {
  connection: Connection | null;
  open: boolean;
  onClose: () => void;
}) {
  const [health, setHealth] = useState<InstanceHealth | null>(null);
  const [checking, setChecking] = useState(false);

  const base = connection
    ? `${connection.secure ? "https" : "http"}://${connection.host}`
    : null;

  const check = useCallback(async () => {
    if (!base) return;
    setChecking(true);
    try {
      const [health_, ready, instance] = await Promise.all([
        probe(base, "/health"),
        probe(base, "/ready"),
        probe(base, "/api/instance"),
      ]);
      setHealth(assessHealth({ health: health_, ready, instance }));
    } finally {
      setChecking(false);
    }
  }, [base]);

  useEffect(() => {
    if (!open) return;
    setHealth(null);
    void check();
  }, [open, check]);

  if (!open || !connection) return null;

  return (
    <div className="panel-backdrop" onClick={onClose}>
      <div
        className="panel"
        role="dialog"
        aria-label={`About ${connection.name}`}
        onClick={event => event.stopPropagation()}
      >
        <header className="panel-head">
          <div>
            <h2>{connection.name}</h2>
            <p className="panel-host">{connection.host}</p>
          </div>
          <button className="panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {!health && checking && <p className="panel-checking">Checking…</p>}

        {health && (
          <>
            <div className={`panel-status panel-status-${health.state}`}>
              <span className="panel-dot" aria-hidden="true" />
              <div>
                <strong>{healthLabel(health.state)}</strong>
                <p>{health.summary}</p>
              </div>
            </div>

            {health.guidance.length > 0 && (
              <ul className="panel-guidance">
                {health.guidance.map(line => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}

            {health.dependencies.length > 0 && (
              <section className="panel-section">
                <h3>Services</h3>
                <ul className="panel-deps">
                  {health.dependencies.map(dependency => (
                    <li key={dependency.name} className={dependency.ok ? "up" : "down"}>
                      <span className="panel-dep-name">{dependency.name}</span>
                      <span className="panel-dep-state">
                        {dependency.ok ? "running" : "not responding"}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {health.capabilities && (
              <section className="panel-section">
                <h3>What this instance supports</h3>
                <ul className="panel-caps">
                  {Object.entries(health.capabilities).map(([key, value]) => (
                    <li key={key} className={value ? "yes" : "no"}>
                      <span>{CAPABILITY_LABELS[key] ?? key}</span>
                      <span>{value ? "yes" : "no"}</span>
                    </li>
                  ))}
                </ul>
                {health.capabilities.e2ee === false ? (
                  <p className="panel-warn">
                    Messages are not end-to-end encrypted. Whoever runs this
                    instance can read them.
                  </p>
                ) : (
                  <p className="panel-note">
                    Encryption is per channel and off by default. Plaintext
                    channels are readable by whoever runs this instance.
                  </p>
                )}
              </section>
            )}

            <section className="panel-section panel-facts">
              {health.version && (
                <div>
                  <span>Version</span>
                  <span>{health.version}</span>
                </div>
              )}
              {health.uptimeSeconds !== null && (
                <div>
                  <span>Up for</span>
                  <span>{formatUptime(health.uptimeSeconds)}</span>
                </div>
              )}
              {health.descriptor && (
                <div>
                  <span>Matrix name</span>
                  <span>{health.descriptor.matrix.serverName}</span>
                </div>
              )}
              {health.descriptor && (
                <div>
                  <span>Protocol</span>
                  <span>
                    {health.descriptor.protocol.major}.{health.descriptor.protocol.minor}
                  </span>
                </div>
              )}
            </section>
          </>
        )}

        <footer className="panel-foot">
          <button onClick={() => void check()} disabled={checking}>
            {checking ? "Checking…" : "Check again"}
          </button>
          {base && (
            <button className="ghost" onClick={() => void openExternal(base)}>
              Open in browser
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
