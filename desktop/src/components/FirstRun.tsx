import markUrl from "../assets/mark.png";
import { IDENTITY_ORIGIN } from "@shared/identityOrigin";
import { useState } from "react";
import { openExternal } from "@/lib/bridge";

/**
 * What someone sees on first launch.
 *
 * Previously this was "No servers yet — add a server", which asks for a
 * hostname before asking who you are. That's the wrong first question: it
 * assumes the person already has a server address to hand, and it hides the
 * fact that a SOVRGNnet account exists at all.
 *
 * Now it offers both, and neither is required. Signing in brings your servers
 * with you; adding one by address works with no account at all, which is the
 * path for someone joining a friend's server that has nothing to do with
 * sovrgnnet.cc.
 */
export default function FirstRun({
  onAddServer,
  onSignIn,
  onHost,
  canHost = false,
  identityUrl = IDENTITY_ORIGIN,
}: {
  onAddServer: () => void;
  onSignIn: () => void;
  /** Open the hosting panel. Only offered when this build bundles a server. */
  onHost?: () => void;
  canHost?: boolean;
  identityUrl?: string;
}) {
  const [showingWhy, setShowingWhy] = useState(false);

  return (
    <div className="firstrun">
      {/* The real mark, not "SN" in a gradient box. alt is empty on purpose:
          the heading below already says SOVRGNnet, and naming it here reads
          the product twice to anyone using a screen reader. */}
      <img className="firstrun-mark" src={markUrl} alt="" />
      <h1>Welcome to SOVRGNnet</h1>
      <p className="dim">
        Chat on servers people own, not companies. Sign in to bring your servers
        with you, connect to one directly — or run your own, right here.
      </p>

      <div className="firstrun-actions">
        <button className="primary" onClick={onSignIn}>
          Sign in with SOVRGNnet
        </button>
        <button className="ghost" onClick={onAddServer}>
          I have a server address
        </button>
        {canHost && onHost && (
          <button className="ghost" onClick={onHost}>
            Run a server on this computer
          </button>
        )}
      </div>

      <button className="linky" onClick={() => setShowingWhy(v => !v)}>
        {showingWhy ? "Hide details" : "Do I need an account?"}
      </button>

      {showingWhy && (
        <div className="firstrun-why">
          <p>
            <strong>No.</strong> An account is a convenience: it remembers which
            servers you've joined, so a new computer picks up where the last one
            left off. Servers work perfectly without one.
          </p>
          <p>
            If you'd rather not have an account at sovrgnnet.cc, use{" "}
            <em>I have a server address</em> and nothing is ever sent there.
          </p>
          <p className="dim">
            Accounts live at{" "}
            <button className="linky inline" onClick={() => void openExternal(identityUrl)}>
              {identityUrl.replace(/^https?:\/\//, "")}
            </button>
            .
          </p>
        </div>
      )}
    </div>
  );
}
