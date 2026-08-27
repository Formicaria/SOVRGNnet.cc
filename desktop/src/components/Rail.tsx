import type { Connection } from "@shared/connections";

/** Two initials, the way a server badge reads at a glance. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .map(word => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Roughly "was this server answering recently?" */
function seenRecently(connection: Connection): boolean {
  return Date.now() - connection.lastSeen < 5 * 60 * 1000;
}

/**
 * The rail of servers.
 *
 * Unlike the rail inside a single instance, every entry here is a *different
 * machine somebody runs*. That's the whole point of the desktop client, so
 * the host is always visible on hover rather than hidden behind a menu.
 */
export default function Rail({
  connections,
  activeId,
  onSelect,
  onAdd,
  onHost,
  onQuit,
}: {
  connections: Connection[];
  activeId: string | null;
  onSelect: (connection: Connection) => void;
  onAdd: () => void;
  /**
   * Opens the Host panel. Optional because it only exists on builds that can
   * host — and it must exist *here*: the panel's other door is the FirstRun
   * screen, which renders only while the rail is empty, so the machine
   * actually hosting a server was the one machine locked out of its own
   * status and Stop button.
   */
  onHost?: () => void;
  /** Quit the app — deliberately, through the path that stops the server. */
  onQuit?: () => void;
}) {
  return (
    <nav className="rail" aria-label="Your servers">
      {connections.map(connection => {
        const active = connection.id === activeId;
        return (
          <button
            key={connection.id}
            className={`rail-item${active ? " is-active" : ""}`}
            onClick={() => onSelect(connection)}
            title={`${connection.name} · ${connection.host}`}
          >
            <span className="rail-badge">{initials(connection.name)}</span>
            <span
              className={`rail-dot${seenRecently(connection) ? " is-up" : ""}`}
              aria-hidden="true"
            />
            <span className="rail-tip">
              <strong>{connection.name}</strong>
              <em>{connection.host}</em>
            </span>
          </button>
        );
      })}

      <button className="rail-item rail-add" onClick={onAdd} title="Add a server">
        <span className="rail-badge">+</span>
        <span className="rail-tip">
          <strong>Add a server</strong>
        </span>
      </button>

      {/* App-level controls sit at the rail's foot, below the servers. */}
      {(onHost || onQuit) && <div className="rail-spacer" aria-hidden="true" />}

      {onHost && (
        <button className="rail-item rail-host" onClick={onHost} title="Your server">
          <span className="rail-badge">⌂</span>
          <span className="rail-tip">
            <strong>Your server</strong>
            <em>status, voice, stop</em>
          </span>
        </button>
      )}

      {onQuit && (
        <button className="rail-item rail-quit" onClick={onQuit} title="Quit SOVRGNnet">
          <span className="rail-badge">⏻</span>
          <span className="rail-tip">
            <strong>Quit</strong>
            <em>stops your server too</em>
          </span>
        </button>
      )}
    </nav>
  );
}
