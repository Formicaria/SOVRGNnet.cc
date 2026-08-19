import markUrl from "@/assets/mark.png";
import { checkUsername } from "@shared/username";
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
  const [username, setUsername] = useState("");
  /** Sign-in accepts either, so the field can't be called "email". */
  const [identifier, setIdentifier] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [inviteCode, setInviteCode] = useState(
    () => sessionStorage.getItem("pending_invite") ?? ""
  );
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

  // What this instance is and who may join — read from the server rather
  // than assumed, because both are the operator's choice. The form below
  // shapes itself around the answer instead of letting a visitor type a
  // doomed signup and learn the policy from a 403.
  const [sso, setSso] = useState<{
    enabled: boolean;
    issuer: string | null;
  } | null>(null);
  const [instance, setInstance] = useState<{
    name: string | null;
    description: string | null;
    joinPolicy: "open" | "invite" | "closed" | null;
    /** No accounts yet — the next one becomes the administrator. */
    needsSetup: boolean;
  }>({ name: null, description: null, joinPolicy: null, needsSetup: false });
  useEffect(() => {
    let cancelled = false;
    fetch("/api/instance")
      .then(res => (res.ok ? res.json() : null))
      .then(info => {
        if (cancelled || !info) return;
        if (info.sso) setSso(info.sso);
        setInstance({
          name: info.server?.name ?? null,
          description: info.server?.description ?? null,
          joinPolicy: info.joinPolicy ?? null,
          needsSetup: info.needsSetup === true,
        });
      })
      .catch(() => {
        // An instance that can't describe itself gets the generic form.
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

  // Signing up on a closed instance isn't possible; on an invite-only one it
  // needs a code. The form says so up front.
  const canSignUp = instance.joinPolicy !== "closed";
  const needsInvite = instance.joinPolicy === "invite";

  // Null until they've typed, so an untouched field isn't already complaining.
  const usernameCheck = username.trim() ? checkUsername(username) : null;
  const usernameProblem =
    usernameCheck && !usernameCheck.ok ? usernameCheck.message : null;

  const handleEmailAuth = async () => {
    try {
      setAuthLoading(true);
      setAuthError(null);
      if (isSignUp) {
        // Re-checked here and not only as they type, because the field can be
        // submitted with Enter before the hint has been read. `register` takes
        // the normalised name this returns rather than the raw input.
        const checked = checkUsername(username);
        if (!checked.ok) {
          setAuthError(checked.message);
          return;
        }
        await register(
          checked.username,
          password,
          email || undefined,
          undefined,
          inviteCode || undefined,
          setupToken || undefined
        );
      } else {
        await login(identifier, password);
      }
      setUsername("");
      setIdentifier("");
      setEmail("");
      setPassword("");
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : "Authentication failed"
      );
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
              <img src={markUrl} alt="" className="h-10 w-auto" />
              <h1 className="wordmark text-2xl">SOVRGN</h1>
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
              Communicate Freely,
              <br />
              <span className="bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                Own Your Data
              </span>
            </h2>
            <p className="text-xl text-slate-300 mb-8 max-w-2xl mx-auto">
              Servers, channels, and conversations on hardware you own. Built on
              the Matrix protocol and IPFS — open standards, no company in the
              middle.
            </p>
            <Button
              onClick={() => setLocation("/dashboard")}
              size="lg"
              className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
            >
              Enter Dashboard
            </Button>
          </div>

          {/* Features Grid */}
          <div className="grid md:grid-cols-2 gap-6 mb-16">
            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Lock className="w-8 h-8 text-purple-400 flex-shrink-0 mt-1" />
                <div>
                  {/* This card once claimed Olm/Megolm that didn't exist, and
                      was corrected to say so plainly — the entire point of the
                      project, see docs/adr/0001. Then the encryption shipped
                      and this text went on saying "not yet" anyway.

                      That is the same failure pointing the other way.
                      Understating is not the safe direction; it is just a
                      different false claim, and it is the first thing a
                      visitor reads. Found by the browser stage, which is the
                      only check that renders this page at all. */}
                  <h3 className="text-xl font-bold mb-2">
                    Nobody's server but yours
                  </h3>
                  <p className="text-slate-300">
                    Messages are encrypted in your browser before they leave
                    it, so what lands in the database is ciphertext the server
                    can't read. It still sees who is in a room and when they
                    post — encryption hides what you said, not that you said
                    it.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Users className="w-8 h-8 text-pink-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">
                    Roles and moderation
                  </h3>
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
                  <h3 className="text-xl font-bold mb-2">
                    Real Matrix underneath
                  </h3>
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
                  <h3 className="text-xl font-bold mb-2">
                    Files on your own node
                  </h3>
                  <p className="text-slate-300">
                    Attachments pin to your IPFS node and stream back through
                    the app with membership checks — no upload service, no links
                    that rot when someone else's plan lapses.
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
                  "End-to-end encrypted messages and files, on by default",
                  "Device verification and a recovery key for your history",
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
              <h3 className="text-2xl font-bold mb-6 text-slate-400">
                Not yet
              </h3>
              <div className="space-y-3">
                {[
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
          {/* Decorative, hence the empty alt: the wordmark directly below says
              SOVRGN in text, so announcing the mark too would read the brand
              name twice to anyone using a screen reader. */}
          <img
            src={markUrl}
            alt=""
            className="h-20 w-auto mx-auto mb-6"
          />
          {/* The wordmark is the brand name, not the instance's name. Set as
              type rather than shipped as an image, the way the site does it —
              one less asset to keep in sync, and it stays selectable,
              searchable and legible to a screen reader. The face and fill live
              in the `.wordmark` class. Note the brand is SOVRGN; SOVRGNnet is
              the software. */}
          <h1 className="wordmark text-5xl">SOVRGN</h1>
          {/* Whose instance this is, in the space the marketing line used to
              occupy. That line claimed the operator was someone you trust and
              that the hardware was theirs — neither of which this page can
              know, and both of which a stranger's invite link could make
              false. Naming the instance says the true version of it. */}
          {instance.name && (
            <p className="mt-3 text-sm text-slate-400">{instance.name}</p>
          )}
        </div>

        <Card className="bg-slate-800 border-slate-700 p-6 space-y-4">
          <div className="space-y-2">
            {isSignUp ? (
              <>
                <Input
                  placeholder="Username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  className="bg-slate-700 border-slate-600"
                  disabled={authLoading}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {/* Checked as they type, with the same function the server
                    uses. Silence until they've typed something, so the field
                    doesn't open by telling them what they did wrong. */}
                {usernameProblem && (
                  <p className="text-xs text-amber-400 text-left">
                    {usernameProblem}
                  </p>
                )}
                <Input
                  type="email"
                  placeholder="Email (optional)"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  className="bg-slate-700 border-slate-600"
                  disabled={authLoading}
                />
                {/* Said plainly, because "optional" on a signup form usually
                    isn't. Nothing here needs it, and leaving it out has one
                    real consequence, which is stated rather than discovered. */}
                <p className="text-xs text-slate-500 text-left">
                  Your account is your username. An email is only used for
                  recovery — without one, losing your password means losing the
                  account.
                </p>
              </>
            ) : (
              <Input
                placeholder="Username or email"
                value={identifier}
                onChange={e => setIdentifier(e.target.value)}
                className="bg-slate-700 border-slate-600"
                disabled={authLoading}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            )}
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="bg-slate-700 border-slate-600"
              disabled={authLoading}
              onKeyPress={e => {
                if (e.key === "Enter") handleEmailAuth();
              }}
            />
            {isSignUp && instance.needsSetup && (
              <>
                <Input
                  placeholder="Setup code"
                  value={setupToken}
                  onChange={e => setSetupToken(e.target.value)}
                  className="bg-slate-700 border-slate-600 font-mono"
                  disabled={authLoading}
                />
                <p className="text-xs text-slate-500 text-left">
                  This instance has no accounts yet, so the next one becomes
                  its administrator. The setup code came with the server: the
                  installer printed it (it stays in{" "}
                  <span className="font-mono">.env</span> as{" "}
                  <span className="font-mono">SOVRGN_SETUP_TOKEN</span>), and a
                  server hosted from the desktop app shows it in the hosting
                  panel — though there, the app offers to create this account
                  itself. It stops being needed after this.
                </p>
              </>
            )}
            {isSignUp && needsInvite && !instance.needsSetup && (
              <>
                <Input
                  placeholder="Invite code"
                  value={inviteCode}
                  onChange={e => setInviteCode(e.target.value)}
                  className="bg-slate-700 border-slate-600 font-mono"
                  disabled={authLoading}
                />
                <p className="text-xs text-slate-500 text-left">
                  This instance is invite-only. Paste the code from your invite
                  link — the part after{" "}
                  <span className="font-mono">/invite/</span>.
                </p>
              </>
            )}
          </div>

          {authError && <div className="text-red-400 text-sm">{authError}</div>}

          {/*
            Gated on the fields this mode actually has.

            This read `!email` until now, which was right only while email was
            the identity. After #29 it made the *optional* email field
            mandatory on sign-up and — worse — disabled the sign-in button
            permanently, since sign-in renders `identifier` and never touches
            `email` at all. A disabled button with no message is the hardest
            kind of broken to report: nothing happens, and nothing says why.
          */}
          <Button
            onClick={handleEmailAuth}
            disabled={
              authLoading ||
              !password ||
              (isSignUp
                ? !username.trim() || Boolean(usernameProblem)
                : !identifier.trim())
            }
            className="w-full bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700"
          >
            {authLoading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />{" "}
                {isSignUp ? "Signing up..." : "Signing in..."}
              </>
            ) : isSignUp ? (
              "Sign Up"
            ) : (
              "Sign In"
            )}
          </Button>

          {canSignUp ? (
            <div className="text-center text-sm text-slate-400">
              {isSignUp
                ? "Already have an account? "
                : "Don't have an account? "}
              <button
                onClick={() => setIsSignUp(!isSignUp)}
                className="text-purple-400 hover:text-purple-300 underline"
                disabled={authLoading}
              >
                {isSignUp ? "Sign In" : "Sign Up"}
              </button>
            </div>
          ) : (
            <p className="text-center text-xs text-slate-500">
              This instance isn't accepting new accounts. Existing members can
              sign in.
            </p>
          )}

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

              {/* Says what the server receives, and that a username is still
                  chosen here — the SSO account doesn't supply one, because a
                  username becomes a permanent Matrix ID and #32 stopped this
                  code inventing those for people. */}
              <p className="text-[11px] text-slate-500 text-center">
                One account for every server that accepts it. You'll still pick
                a username here. This server learns your name and email — never
                your password.
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
