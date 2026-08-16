import { useState } from "react";
import {
  ConnectionManager,
  NotASovrgnServer,
  ServerTooNew,
  normalizeHost,
  probeInstance,
  type Connection,
  type InstanceInfo,
} from "@shared/connections";
import { parseInvite, serverBaseUrl } from "@shared/invite";

/**
 * Add a server, in two deliberate steps: look, then join.
 *
 * The client asks the address what it is and shows the answer before saving
 * anything, so a typo produces "that isn't a SOVRGNnet server" rather than a
 * password field on a stranger's website.
 */
export default function AddServer({
  open,
  onClose,
  onAdded,
  manager,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: (connection: Connection) => void | Promise<void>;
  manager: ConnectionManager;
}) {
  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<{ info: InstanceInfo; base: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const reset = () => {
    setInput("");
    setFound(null);
    setError(null);
    setChecking(false);
  };

  const look = async () => {
    const raw = input.trim();
    if (!raw || checking) return;

    setChecking(true);
    setError(null);
    setFound(null);
    try {
      // An invite names its own server, so it doubles as an address.
      const invite = parseInvite(raw);
      const base = invite ? serverBaseUrl(invite) : serverBaseUrl(normalizeHost(raw));
      setFound({ info: await probeInstance(base), base });
    } catch (err) {
      if (err instanceof ServerTooNew) {
        setError("That server is newer than this app. Update, then try again.");
      } else if (err instanceof NotASovrgnServer) {
        setError(
          "Couldn't find a SOVRGNnet server there. Check the address, and that the machine is switched on."
        );
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setChecking(false);
    }
  };

  const join = async () => {
    if (!found) return;
    try {
      const connection = await manager.connect(found.base);
      await onAdded(connection);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that server");
    }
  };

  return (
    <div
      className="scrim"
      onClick={() => {
        reset();
        onClose();
      }}
    >
      <div className="dialog" onClick={event => event.stopPropagation()}>
        <h2>Add a server</h2>
        <p className="dim">Paste an invite link, or the address of a server someone runs.</p>

        <input
          autoFocus
          value={input}
          onChange={event => {
            setInput(event.target.value);
            setFound(null);
            setError(null);
          }}
          onKeyDown={event => {
            if (event.key === "Enter") {
              event.preventDefault();
              void (found ? join() : look());
            }
            if (event.key === "Escape") {
              reset();
              onClose();
            }
          }}
          placeholder="chat.example.com  ·  https://…/invite/abc123"
          spellCheck={false}
        />

        {error && <p className="error">{error}</p>}

        {found && (
          <div className="found">
            <strong>{found.info.name}</strong>
            {found.info.description && <p className="dim">{found.info.description}</p>}
            <p className="mono dim">
              {found.info.matrixServerName} · v{found.info.software.version}
            </p>

            {/* Stated every time. Someone about to type a password deserves
                to know which kind of server they're looking at. */}
            <p className={found.info.encryption ? "ok" : "warn"}>
              {found.info.encryption
                ? "Messages here are end-to-end encrypted."
                : "Not end-to-end encrypted — whoever runs this server can read messages on it."}
            </p>

            {found.info.joinPolicy === "closed" && (
              <p className="dim">
                This server isn't accepting new accounts. You can add it, but
                you'll need an existing account to sign in.
              </p>
            )}
          </div>
        )}

        <div className="dialog-actions">
          <button
            className="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
          >
            Cancel
          </button>
          {found ? (
            <button className="primary" onClick={() => void join()}>
              Add server
            </button>
          ) : (
            <button
              className="primary"
              disabled={!input.trim() || checking}
              onClick={() => void look()}
            >
              {checking ? "Looking…" : "Look it up"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
