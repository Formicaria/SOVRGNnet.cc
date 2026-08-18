import { useEffect, useRef, useState } from "react";
import {
  DEVICE_POLL_INTERVAL_SECONDS,
  interpretPollResponse,
  remainingSeconds,
  type DeviceAuthorization,
} from "@shared/deviceFlow";
import { openExternal } from "@/lib/bridge";

/**
 * Signing in to sovrgnnet.cc from the desktop, using the device flow.
 *
 * The app shows a short code, the person approves it in their own browser,
 * and the app polls until that happens. Nothing sensitive is passed back
 * through a URL — see shared/deviceFlow.ts for why the redirect flow the web
 * uses would be unsafe here.
 */
export default function SignIn({
  identityUrl,
  onSignedIn,
  onCancel,
}: {
  identityUrl: string;
  onSignedIn: (sessionToken: string) => void;
  onCancel: () => void;
}) {
  const [auth, setAuth] = useState<DeviceAuthorization | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const cancelled = useRef(false);

  // Request a code once, then poll until it's approved, refused, or expires.
  useEffect(() => {
    cancelled.current = false;

    void (async () => {
      try {
        // A fetch that never *completes* throws a bare TypeError, and every
        // engine words it differently and uselessly: WebKitGTK — the webview
        // on Linux — says "Load failed", which names no host and no cause.
        //
        // Deliberately vague about which failure it was, because the fetch API
        // cannot tell us. A request that never left and a response the browser
        // refused to expose are the same TypeError with the same message.
        //
        // Worth knowing, since this cost an evening: the second case was real.
        // The identity service sent no CORS headers on the device-flow
        // endpoints, so the request arrived, was answered correctly, and the
        // browser discarded the reply. `curl` succeeded throughout, because
        // nothing outside a browser enforces CORS. Claiming "the request
        // didn't get there" sent the search to DNS and the network, which were
        // both fine.
        const res = await fetch(`${identityUrl}/api/device/code`, {
          method: "POST",
        }).catch(() => {
          throw new Error(
            `Couldn't reach ${identityUrl.replace(/^https?:\/\//, "")}. ` +
              "Either the request didn't get there, or it did and the reply " +
              "was blocked before this app could read it. Nothing is wrong " +
              "with your account."
          );
        });

        // 404 and 405 both mean "nothing at this origin implements the device
        // flow" — 405 in particular is what a *static* host answers a POST
        // with, which is exactly what happens when this points at a marketing
        // site instead of a running identity service. That was the real state
        // of the default origin, and the screen used to report it as
        // "Couldn't start sign-in (405)": a number that sends whoever reads it
        // looking for a bug in the sign-in code rather than at a service that
        // was never deployed.
        //
        // Say the true thing instead. It costs nothing when the service *is*
        // running, and it is the difference between a dead end and a fact.
        if (res.status === 404 || res.status === 405) {
          throw new Error(
            `No identity service at ${identityUrl.replace(/^https?:\/\//, "")} — ` +
              "sovrgnnet.cc accounts aren't available yet. " +
              "Connect to a server directly, or run one on this computer."
          );
        }
        if (!res.ok) throw new Error(`Couldn't start sign-in (${res.status})`);

        // A body that isn't JSON is the same class of problem wearing a 200:
        // an index page, a redirect landing, a proxy notice. Reading it as JSON
        // throws something about unexpected tokens, which is no more use than
        // the status code was.
        let body: {
          device_code?: string;
          user_code?: string;
          verification_uri?: string;
          expires_in?: number;
          interval?: number;
        };
        try {
          body = await res.json();
        } catch {
          throw new Error(
            `${identityUrl.replace(/^https?:\/\//, "")} answered, but not with ` +
              "a sign-in code — it doesn't look like an identity service."
          );
        }
        if (!body.device_code || !body.user_code || !body.verification_uri) {
          throw new Error(
            "That sign-in response was missing fields the flow needs."
          );
        }
        const authorization: DeviceAuthorization = {
          deviceCode: body.device_code,
          userCode: body.user_code,
          verificationUri: body.verification_uri,
          expiresAt: Date.now() + (body.expires_in ?? 600) * 1000,
          intervalSeconds: body.interval ?? DEVICE_POLL_INTERVAL_SECONDS,
        };
        if (cancelled.current) return;
        setAuth(authorization);

        // Open the browser for them — but the code stays on screen, because
        // the browser may open behind the window or not at all.
        void openExternal(authorization.verificationUri);

        let interval = authorization.intervalSeconds;
        while (!cancelled.current) {
          await new Promise(r => setTimeout(r, interval * 1000));
          if (cancelled.current) return;

          if (Date.now() >= authorization.expiresAt) {
            setError("That code expired. Try again.");
            return;
          }

          const poll = await fetch(`${identityUrl}/api/device/token`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ device_code: authorization.deviceCode }),
          });
          const pollBody = await poll.json().catch(() => null);
          const result = interpretPollResponse(poll.status, pollBody, interval);

          if (result.status === "approved") {
            onSignedIn(result.sessionToken);
            return;
          }
          if (result.status === "slow-down") interval = result.intervalSeconds;
          if (result.status === "denied") {
            setError("Sign-in was refused.");
            return;
          }
          if (result.status === "expired") {
            setError("That code expired. Try again.");
            return;
          }
        }
      } catch (err) {
        if (!cancelled.current) {
          setError(err instanceof Error ? err.message : "Sign-in failed");
        }
      }
    })();

    return () => {
      cancelled.current = true;
    };
  }, [identityUrl, onSignedIn]);

  useEffect(() => {
    if (!auth) return;
    const timer = setInterval(() => setCountdown(remainingSeconds(auth)), 1000);
    return () => clearInterval(timer);
  }, [auth]);

  return (
    <div className="firstrun">
      <h1>Sign in</h1>

      {error ? (
        <>
          <p className="error">{error}</p>
          <div className="firstrun-actions">
            <button className="ghost" onClick={onCancel}>
              Back
            </button>
          </div>
        </>
      ) : !auth ? (
        <p className="dim">Starting…</p>
      ) : (
        <>
          <p className="dim">
            Your browser should have opened. Enter this code there to finish
            signing in.
          </p>

          <div className="devicecode">{auth.userCode}</div>

          <p className="dim">
            {countdown > 0
              ? `Expires in ${Math.floor(countdown / 60)}:${String(countdown % 60).padStart(2, "0")}`
              : "Waiting…"}
          </p>

          <div className="firstrun-actions">
            <button className="ghost" onClick={() => void openExternal(auth.verificationUri)}>
              Open the page again
            </button>
            <button className="ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
