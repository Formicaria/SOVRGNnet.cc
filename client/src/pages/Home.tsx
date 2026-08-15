import { useAuth } from "@/contexts/AuthContext";
import { useWeb3 } from "@/contexts/Web3Context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, Zap, Lock, Users, MessageCircle } from "lucide-react";
import { useLocation } from "wouter";
import { useState } from "react";

export default function Home() {
  const { user, loading, login, register } = useAuth();
  const { isConnected, connect } = useWeb3();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

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
              <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center font-bold">
                DD
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
              A decentralized communication platform built on Web3, Matrix protocol, and IPFS. 
              Encrypted, private, and completely under your control.
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
                  <h3 className="text-xl font-bold mb-2">End-to-End Encrypted</h3>
                  <p className="text-slate-300">
                    All messages and calls are encrypted using Matrix's Olm/Megolm protocol. 
                    Only you and your recipients can read your communications.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Users className="w-8 h-8 text-pink-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">Decentralized Identity</h3>
                  <p className="text-slate-300">
                    Connect with your Web3 wallet and ENS name. Your identity is portable 
                    and not tied to any single platform.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <MessageCircle className="w-8 h-8 text-blue-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">Federated Messaging</h3>
                  <p className="text-slate-300">
                    Built on the Matrix protocol, enabling true federation. 
                    No single point of failure or control.
                  </p>
                </div>
              </div>
            </Card>

            <Card className="bg-slate-800 border-slate-700 p-6 hover:border-purple-500 transition-colors">
              <div className="flex items-start gap-4">
                <Zap className="w-8 h-8 text-yellow-400 flex-shrink-0 mt-1" />
                <div>
                  <h3 className="text-xl font-bold mb-2">Premium Features</h3>
                  <p className="text-slate-300">
                    NFT-based "Nitro" subscription unlocks HD video, custom emojis, 
                    and exclusive soundboards.
                  </p>
                </div>
              </div>
            </Card>
          </div>

          {/* Features List */}
          <div className="bg-slate-800 border border-slate-700 rounded-lg p-8">
            <h3 className="text-2xl font-bold mb-6">Powerful Features</h3>
            <div className="grid md:grid-cols-2 gap-4">
              {[
                "Real-time messaging with Matrix protocol",
                "Voice and video calls with MatrixRTC + LiveKit",
                "Large file sharing (500MB+) via IPFS & WebTorrent",
                "Built-in soundboard with low-latency playback",
                "NFT-based Nitro subscription system",
                "Role-based permissions and moderation",
                "Offline message queue and sync",
                "Cross-device synchronization",
              ].map((feature, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-gradient-to-r from-purple-400 to-pink-400" />
                  <span className="text-slate-300">{feature}</span>
                </div>
              ))}
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
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center font-bold text-4xl mx-auto mb-6">
            DD
          </div>
          <h1 className="text-5xl font-bold mb-4">SOVRGNnet</h1>
          <p className="text-xl text-slate-300">
            A Web3-native communication platform with end-to-end encryption and true decentralization.
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
