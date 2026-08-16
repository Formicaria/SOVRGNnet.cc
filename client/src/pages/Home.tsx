import { useAuth } from "@/contexts/AuthContext";
import { useWeb3 } from "@/contexts/Web3Context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Zap, Lock, Users, MessageCircle } from "lucide-react";
import { useLocation } from "wouter";
import { useEffect, useState } from "react";

export default function Home() {
  const { user, loading, login, register } = useAuth();
  const { isConnected, connect } = useWeb3();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // If the user arrived via an invite link before signing in, resume it.
  useEffect(() => {
    if (!user) return;
    const pending = sessionStorage.getItem("pending_invite");
    if (pending) {
      sessionStorage.removeItem("pending_invite");
      setLocation(`/invite/${pending}`);
    }
  }, [user, setLocation]);

<<<<<<< HEAD
=======
  // Whether this server accepts sovrgnnet.cc accounts. Read from the server
  // rather than assumed, because it's an operator's choice and most instances
  // will have it switched off.
  const [sso, setSso] = useState<{ enabled: boolean; issuer: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/instance")
      .then(res => (res.ok ? res.json() : null))
      .then(info => {
        if (!cancelled && info?.sso) setSso(info.sso);
      })
      .catch(() => {
        // An instance that can't describe itself simply doesn't offer SSO.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const startSso = () => {
    if (!sso?.issuer) return;
    const returnUrl = `${window.location.origin}/sso/callback`;
    window.location.href = `${sso.issuer.replace(/\/+$/, "")}/authorize?return=${encodeURIComponent(returnUrl)}`;
  };

>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
  const handleEmailAuth = async () => {
    try {
      setAuthLoading(true);
      setAuthError(null);
      if (isSignUp) {
        await register(email, password);
      } else {
        await login(email, password);
      }
      setEmail("");
      setPassword("");
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setAuthLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
        <Loader2 className="animate-spin w-8 h-8 text-purple-500" />
      </div>
    );
  }

  if (user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white">
        {/* Navigation */}
        <nav className="border-b border-slate-700 bg-slate-900/50 backdrop-blur">
          <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center font-bold text-sm">
                SN
              </div>
              <h1 className="text-2xl font-bold">SOVRGNnet</h1>
            </div>
            <Button onClick={() => setLocation("/dashboard")} size="lg">
              Go to Dashboard
            </Button>
          </div>
        </nav>

        {/* Hero Section */}
        <div className="max-w-6xl mx-auto px-6 py-20">
          <div className="text-center mb-16">
            <h2 className="text-5xl font-bold mb-4">
              Communicate Freely,<br />
              <span className="bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                Own Your Data
              </span>
            </h2>
            <p className="text-xl text-slate-300 mb-8 max-w-2xl mx-auto">
              Servers, channels, and conversations on hardware you own. Built on
              the Matrix protocol and IPFS — open standards, no company in the
              middle.
            </p>
            <Button onClick={() => setLocation("/dashboard")} size="lg" className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700">
              Enter Dashboard
            </Button>
          </div>

          {/* Features Grid */}
          <div className="grid md:grid-cols-2 gap-6 mb-16">
            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Lock className="w-8 h-8 text-purple-400 flex-shrink-0 mt-1" />
                <div>
                  {/* This card used to claim Olm/Megolm encryption that does
                      not exist yet. Saying so plainly is the entire point of
                      the project — see docs/adr/0001. */}
                  <h3 className="text-xl font-bold mb-2">Nobody's server but yours</h3>
                  <p className="text-slate-300">
                    Messages live in your database, on your machine. Not yet
                    end-to-end encrypted — whoever runs this server can read
                    them, and that's on the roadmap to fix.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Users className="w-8 h-8 text-pink-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">Roles and moderation</h3>
                  <p className="text-slate-300">
                    Owners, admins, moderators, members — enforced on every
                    request, not just hidden in the interface. Invite links,
                    kicks, and bans included.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <MessageCircle className="w-8 h-8 text-blue-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">Real Matrix underneath</h3>
                  <p className="text-slate-300">
                    Every message is an event on your own homeserver, so other
                    Matrix clients can read the same rooms. Federation is
                    available and off by default — your call, not ours.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Zap className="w-8 h-8 text-yellow-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">Files on your own node</h3>
                  <p className="text-slate-300">
                    Attachments pin to your IPFS node and stream back through
                    the app with membership checks — no upload service, no
                    links that rot when someone else's plan lapses.
                  </p>
                </div>
              </div>
            </Card>
          </div>

          {/* Two lists, deliberately. Conflating what works with what's
              planned is how a project ends up lying to its own users. */}
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
              <h3 className="text-2xl font-bold mb-6">Working today</h3>
              <div className="space-y-3">
                {[
                  "Servers, channels, and text chat over Matrix",
                  "File sharing on your own IPFS node",
                  "Invite links, including for private servers",
                  "Roles, kicks, bans, and message moderation",
                  "Message editing, reactions, typing indicators",
                  "One-command install, backups, and updates",
                ].map((feature, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-gradient-to-r from-purple-400 to-pink-400 mt-2 shrink-0" />
                    <span className="text-slate-300">{feature}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-slate-800/50 border border-slate-700 rounded-lg p-8">
              <h3 className="text-2xl font-bold mb-6 text-slate-400">Not yet</h3>
              <div className="space-y-3">
                {[
                  "End-to-end encryption",
                  "Voice and video channels",
                  "Desktop client with multi-server support",
                  "Password reset by email",
                  "Mobile apps",
                  "Soundboard",
                ].map((feature, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <div className="w-2 h-2 rounded-full bg-slate-600 mt-2 shrink-0" />
                    <span className="text-slate-400">{feature}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 text-white flex flex-col items-center justify-center">
      <div className="text-center space-y-8 max-w-md">
        <div>
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center font-bold text-3xl mx-auto mb-6">
            SN
          </div>
          <h1 className="text-5xl font-bold mb-4">SOVRGNnet</h1>
<<<<<<< HEAD
=======
          {/* Claims on this page must be true today, not on the roadmap. This
              is the last thing someone reads before typing a password. */}
>>>>>>> 59fe78b92b13dd24738ba6c6ec20a07003f32a03
          <p className="text-xl text-slate-300">
            Chat on a server someone you trust actually owns. Built on Matrix
            and IPFS, running on their hardware — not a company's.
          </p>
        </div>

        <Card className="bg-slate-800 border-slate-700 p-6 space-y-4">
          <div className="space-y-2">
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-slate-700 border-slate-600"
              disabled={authLoading}
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="bg-slate-700 border-slate-600"
              disabled={authLoading}
              onKeyPress={(e) => {
                if (e.key === "Enter") handleEmailAuth();
              }}
            />
          </div>

          {authError && (
            <div className="text-red-400 text-sm">{authError}</div>
          )}

          <Button
            onClick={handleEmailAuth}
            disabled={authLoading || !email || !password}
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
          >
            {authLoading ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> {isSignUp ? "Signing up..." : "Signing in..."}</>
            ) : (
              isSignUp ? "Sign Up" : "Sign In"
            )}
          </Button>

          <div className="text-center text-sm text-slate-400">
            {isSignUp ? "Already have an account? " : "Don't have an account? "}
            <button
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-purple-400 hover:text-purple-300 underline"
              disabled={authLoading}
            >
              {isSignUp ? "Sign In" : "Sign Up"}
            </button>
          </div>

          {/* Only shown when the operator has opted in. Most instances won't,
              and an inert button would just raise questions. */}
          {sso?.enabled && sso.issuer && (
            <>
              <div className="flex items-center gap-3 pt-2">
                <div className="h-px flex-1 bg-slate-700" />
                <span className="text-xs text-slate-500">or</span>
                <div className="h-px flex-1 bg-slate-700" />
              </div>

              <Button
                variant="outline"
                onClick={startSso}
                disabled={authLoading}
                className="w-full border-slate-600 bg-slate-800/60 hover:bg-slate-700"
              >
                Continue with SOVRGNnet
              </Button>

              <p className="text-[11px] text-slate-500 text-center">
                One account for every server that accepts it. This server will
                learn your name and email — not your password.
              </p>
            </>
          )}
        </Card>

        <div className="space-y-2">
          <Button
            size="lg"
            variant="outline"
            onClick={connect}
            className="w-full border-slate-600"
          >
            Connect Wallet
          </Button>
        </div>
      </div>
    </div>
  );
}
