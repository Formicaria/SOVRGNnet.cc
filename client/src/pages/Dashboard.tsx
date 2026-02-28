import { useSupabaseAuth } from "@/contexts/SupabaseAuthContext";
import { useWeb3 } from "@/contexts/Web3Context";
import { useMatrix } from "@/contexts/MatrixContext";
import { useIPFS } from "@/contexts/IPFSContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Loader2, Plus, Send, Volume2, LogOut, AlertCircle } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

export default function Dashboard() {
  const { user, signOut } = useSupabaseAuth();
  const { address, ensName, isConnected, connect, disconnect } = useWeb3();
  const { isConnected: matrixConnected, error: matrixError } = useMatrix();
  const { isUploading } = useIPFS();
  const createRoomMutation = trpc.matrix.createRoom.useMutation();
  
  const [, setLocation] = useLocation();
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);

  // Redirect to home if not authenticated
  useEffect(() => {
    if (!user) {
      setLocation("/");
    }
  }, [user, setLocation]);

  if (!user) {
    return <div className="flex items-center justify-center h-screen"><Loader2 className="animate-spin" /></div>;
  }

  const handleCreateRoom = async () => {
    if (!newRoomName.trim()) return;
    try {
      setOperationError(null);
      await createRoomMutation.mutateAsync({ name: newRoomName });
      setNewRoomName("");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to create room";
      setOperationError(errorMsg);
      console.error("Failed to create room:", err);
    }
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedRoom) return;
    try {
      setOperationError(null);
      // TODO: Implement message sending via tRPC
      setMessageInput("");
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to send message";
      setOperationError(errorMsg);
      console.error("Failed to send message:", err);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      setLocation("/");
    } catch (err) {
      console.error("Failed to sign out:", err);
    }
  };

  const handleConnectWallet = async () => {
    try {
      setOperationError(null);
      await connect();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to connect wallet";
      setOperationError(errorMsg);
      console.error("Failed to connect wallet:", err);
    }
  };

  const handleDisconnectWallet = async () => {
    try {
      setOperationError(null);
      await disconnect();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to disconnect wallet";
      setOperationError(errorMsg);
      console.error("Failed to disconnect wallet:", err);
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {/* Sidebar - Servers */}
      <div className="w-20 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-4 gap-4">
        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-purple-500 to-pink-500 flex items-center justify-center text-white font-bold">
          DD
        </div>
        <div className="h-px bg-slate-700 w-8" />
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full hover:bg-slate-800"
          onClick={() => setIsCreatingRoom(!isCreatingRoom)}
          title="Create Channel"
        >
          <Plus className="w-5 h-5" />
        </Button>
      </div>

      {/* Server Channels */}
      <div className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h2 className="font-bold text-lg">Channels</h2>
          {matrixError && (
            <div className="mt-2 text-xs text-yellow-400 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" />
              Matrix unavailable
            </div>
          )}
        </div>

        {isCreatingRoom && (
          <div className="p-4 border-b border-slate-700 space-y-2">
            <Input
              placeholder="Room name..."
              value={newRoomName}
              onChange={(e) => setNewRoomName(e.target.value)}
              className="bg-slate-700 border-slate-600"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={handleCreateRoom}
                className="flex-1"
                disabled={!newRoomName.trim() || !matrixConnected}
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsCreatingRoom(false)}
                className="flex-1"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Room List */}
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 text-sm text-slate-400">
            No channels yet. Create one with the + button.
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="h-16 bg-slate-800 border-b border-slate-700 flex items-center justify-between px-6">
          <div>
            <h1 className="font-bold text-lg">
              {selectedRoom ? `# Channel` : "Welcome"}
            </h1>
            <p className="text-xs text-slate-400">
              {address ? `Connected: ${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {isConnected ? (
              <Button size="sm" variant="outline" onClick={handleDisconnectWallet}>
                Disconnect Wallet
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnectWallet}>
                Connect Wallet
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={handleLogout}>
              <LogOut className="w-4 h-4 mr-2" />
              Logout
            </Button>
          </div>
        </div>

        {/* Error Banner */}
        {operationError && (
          <div className="bg-red-900/20 border-b border-red-700 px-6 py-3 text-red-300 text-sm flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {operationError}
          </div>
        )}

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          <div className="text-center text-slate-400 mt-8">
            <p>Select a channel to start messaging</p>
            <p className="text-xs mt-2">or create a new one with the + button</p>
          </div>
        </div>

        {/* Message Input */}
        {selectedRoom && (
          <div className="h-20 bg-slate-800 border-t border-slate-700 p-4 flex gap-2">
            <Input
              placeholder="Type a message..."
              value={messageInput}
              onChange={(e) => setMessageInput(e.target.value)}
              onKeyPress={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              className="bg-slate-700 border-slate-600"
              disabled={!matrixConnected}
            />
            <Button
              onClick={handleSendMessage}
              disabled={!messageInput.trim() || !matrixConnected}
              size="icon"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        )}
      </div>

      {/* Right Sidebar - User Profile & Status */}
      <div className="w-64 bg-slate-800 border-l border-slate-700 p-6 flex flex-col justify-between">
        <div>
          <h3 className="font-bold mb-4">Profile</h3>
          <Card className="bg-slate-700 border-slate-600 p-4 space-y-2">
            <div>
              <p className="text-xs text-slate-400">User</p>
              <p className="text-sm font-mono">{user?.email || "Anonymous"}</p>
            </div>
            <div>
              <p className="text-xs text-slate-400">Wallet</p>
              <p className="text-sm font-mono">
                {address ? `${address.slice(0, 6)}...${address.slice(-4)}` : "Not connected"}
              </p>
            </div>
          </Card>
        </div>

        <div>
          <h3 className="font-bold mb-4">Status</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${matrixConnected ? "bg-green-500" : "bg-red-500"}`} />
              <span>Matrix: {matrixConnected ? "Connected" : "Offline"}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-yellow-500"}`} />
              <span>Wallet: {isConnected ? "Connected" : "Disconnected"}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span>Auth: Connected</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
