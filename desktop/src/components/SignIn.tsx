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
        const res = await fetch(`${identityUrl}/api/device/code`, { method: "POST" });
        if (!res.ok) throw new Error(`Couldn't start sign-in (${res.status})`);

        const body = await res.json();
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
