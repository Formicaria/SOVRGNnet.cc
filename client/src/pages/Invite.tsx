import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { trpc } from "@/lib/trpc";

/** Landing page for invite links: /invite/:code */
export default function Invite() {
  const { user, loading } = useAuth();
  const [, params] = useRoute("/invite/:code");
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<"joining" | "error">("joining");
  const [message, setMessage] = useState<string | null>(null);
  const attempted = useRef(false);

  const joinMutation = trpc.servers.joinByInvite.useMutation({
    onSuccess: res => {
      setMessage(`Joined ${res.serverName}!`);
      setTimeout(() => setLocation("/dashboard"), 800);
    },
    onError: err => {
      setStatus("error");
      setMessage(err.message);
    },
  });

  useEffect(() => {
    if (loading || attempted.current) return;
    if (!user) {
      // Not signed in: send to home; the code survives in sessionStorage.
      if (params?.code) sessionStorage.setItem("pending_invite", params.code);
      setLocation("/");
      return;
    }
    if (params?.code) {
      attempted.current = true;
      joinMutation.mutate({ code: params.code });
    }
  }, [loading, user, params?.code]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-100 gap-4">
      {status === "joining" ? (
        <>
          <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
          <p className="text-slate-300">{message ?? "Joining server…"}</p>
        </>
      ) : (
        <>
          <p className="text-red-400">{message ?? "This invite is invalid."}</p>
          <Button onClick={() => setLocation("/")}>Go home</Button>
        </>
      )}
    </div>
  );
}
