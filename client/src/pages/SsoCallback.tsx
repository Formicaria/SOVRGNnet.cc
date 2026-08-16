import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readTokenFromFragment } from "@shared/ssoFlow";
import { trpc } from "@/lib/trpc";

/**
 * Where sovrgnnet.cc sends people back to after signing in.
 *
 * The token arrives in the URL fragment, which never reaches this server as
 * part of the request — it's read here in the browser and exchanged for an
 * ordinary session, then wiped from the address bar so it doesn't sit in
 * history or get copied out of a shared screenshot.
 */
export default function SsoCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const attempted = useRef(false);

  const utils = trpc.useUtils();
  const ssoLogin = trpc.auth.ssoLogin.useMutation({
    onSuccess: async user => {
      utils.auth.me.setData(undefined, user);
      setLocation("/dashboard");
    },
    onError: e => setError(e.message),
  });

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const token = readTokenFromFragment(window.location.hash);
    if (!token) {
      setError("That sign-in didn't carry a token. Try again from the login page.");
      return;
    }

    // Out of the address bar before anything else happens.
    window.history.replaceState(null, "", window.location.pathname);
    ssoLogin.mutate({ token });
  }, [ssoLogin]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-100 gap-4 px-6">
      {error ? (
        <>
          <p className="text-red-300 max-w-md text-center">{error}</p>
          <Button onClick={() => setLocation("/")}>Back to sign in</Button>
        </>
      ) : (
        <>
          <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          <p className="text-slate-400">Signing you in…</p>
        </>
      )}
    </div>
  );
}
