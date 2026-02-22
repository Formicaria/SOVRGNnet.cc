import { useSupabaseAuth } from "@/contexts/SupabaseAuthContext";
import { useWeb3 } from "@/contexts/Web3Context";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2, Zap, Lock, Users, MessageCircle, Github, Mail } from "lucide-react";
import { useLocation } from "wouter";

export default function Home() {
  const { user, loading, signInWithGoogle, signInWithGitHub } = useSupabaseAuth();
  const { isConnected, connect } = useWeb3();
  const [, setLocation] = useLocation();

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
              <h1 className="text-2xl font-bold">Decentralized Discord</h1>
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
      <div className="text-center space-y-8">
        <div>
          <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center font-bold text-4xl mx-auto mb-6">
            DD
          </div>
          <h1 className="text-5xl font-bold mb-4">Decentralized Discord</h1>
          <p className="text-xl text-slate-300 max-w-md">
            A Web3-native communication platform with end-to-end encryption and true decentralization.
          </p>
        </div>

        <div className="flex gap-4 flex-wrap justify-center">
          <Button
            size="lg"
            onClick={signInWithGoogle}
            className="bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 flex items-center gap-2"
          >
            <Mail className="w-5 h-5" />
            Sign In with Google
          </Button>
          <Button
            size="lg"
            onClick={signInWithGitHub}
            className="bg-gradient-to-r from-gray-700 to-gray-900 hover:from-gray-800 hover:to-black flex items-center gap-2"
          >
            <Github className="w-5 h-5" />
            Sign In with GitHub
          </Button>
          <Button
            size="lg"
            variant="outline"
            onClick={connect}
            className="border-purple-500 text-purple-400 hover:bg-purple-500/10"
          >
            Connect Wallet
          </Button>
        </div>

        <div className="text-sm text-slate-400">
          <p>Sign in with Google/GitHub or connect your Web3 wallet to get started</p>
        </div>
      </div>
    </div>
  );
}
