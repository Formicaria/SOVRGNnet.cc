import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readTokenFromFragment } from "@shared/ssoFlow";
import { checkUsername } from "@shared/username";
import { trpc } from "@/lib/trpc";

/**
 * Where sovrgnnet.cc sends people back to after signing in.
 *
 * The token arrives in the URL fragment, which never reaches this server as
 * part of the request — it's read here in the browser and exchanged for an
 * ordinary session, then wiped from the address bar so it doesn't sit in
 * history or get copied out of a shared screenshot.
 *
 * Two outcomes. A provider identity already bound to an account signs straight
 * in. One that isn't stops here and asks for a username, because that name
 * becomes a permanent Matrix ID and picking it for someone is not a decision
 * this code gets to make.
 */
export default function SsoCallback() {
  const [, setLocation] = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState("");
  const [needsUsername, setNeedsUsername] = useState(false);
  const attempted = useRef(false);

  /**
   * The token, held for the second call.
   *
   * In memory and nowhere else. It has already been removed from the address
   * bar, and putting it in sessionStorage to survive a reload would undo that
   * — a bearer credential in storage is readable by anything that manages to
   * run script on this origin. If the page is reloaded the token is gone and
   * the person signs in again, which is the correct trade.
   */
  const tokenRef = useRef<string | null>(null);

  const utils = trpc.useUtils();

  const ssoLogin = trpc.auth.ssoLogin.useMutation({
    onSuccess: async result => {
      if (result.status === "signed-in") {
        utils.auth.me.setData(undefined, result.user);
        setLocation("/dashboard");
        return;
      }
      setUsername(result.suggestion ?? "");
      setNeedsUsername(true);
    },
    onError: e => setError(e.message),
  });

  const ssoRegister = trpc.auth.ssoRegister.useMutation({
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
    tokenRef.current = token;

    // Out of the address bar before anything else happens.
    window.history.replaceState(null, "", window.location.pathname);
    ssoLogin.mutate({ token });
  }, [ssoLogin]);

  // Same check the server runs, so the field can't accept a name the next
  // request will reject.
  const check = username.trim() ? checkUsername(username) : null;
  const problem = check && !check.ok ? check.message : null;

  const submitUsername = () => {
    const token = tokenRef.current;
    if (!token) {
      setError("That sign-in expired. Start again from the login page.");
      return;
    }
    const checked = checkUsername(username);
    if (!checked.ok) {
      setError(checked.message);
      return;
    }
    setError(null);
    ssoRegister.mutate({ token, username: checked.username });
  };

  const busy = ssoRegister.isPending;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-100 gap-4 px-6">
      {error ? (
        <>
          <p className="text-red-300 max-w-md text-center">{error}</p>
          <Button onClick={() => setLocation("/")}>Back to sign in</Button>
        </>
      ) : needsUsername ? (
        <div className="w-full max-w-sm space-y-3 text-center">
          <h1 className="text-xl font-semibold">Choose a username</h1>
          {/*
            Careful with this sentence. It used to say the name "can't be
            changed later", which stopped being true when renaming landed
            (ADR 0012) — but the *Matrix* address really is permanent, and it
            is taken from whatever is typed here. Saying "you can change this"
            without that second half would be the more damaging error of the
            two, so both are here.
          */}
          <p className="text-sm text-slate-400">
            This is how people find you here. You can change it later, but your
            Matrix address is built from it now and keeps this name for good.
          </p>
          <Input
            placeholder="Username"
            value={username}
            onChange={e => setUsername(e.target.value)}
            className="bg-slate-800 border-slate-700"
            disabled={busy}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={e => {
              if (e.key === "Enter") submitUsername();
            }}
          />
          {problem && <p className="text-xs text-amber-400">{problem}</p>}
          <Button
            className="w-full"
            onClick={submitUsername}
            disabled={busy || !check?.ok}
          >
            {busy ? "Creating your account…" : "Continue"}
          </Button>
        </div>
      ) : (
        <>
          <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          <p className="text-slate-400">Signing you in…</p>
        </>
      )}
    </div>
  );
}
