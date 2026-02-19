import { useAuth } from "@/_core/hooks/useAuth";
import { useWeb3 } from "@/contexts/Web3Context";
import { useMatrix } from "@/contexts/MatrixContext";
import { useIPFS } from "@/contexts/IPFSContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Loader2, Plus, Send, Volume2, LogOut } from "lucide-react";
import { useState, useEffect } from "react";
import { useLocation } from "wouter";

export default function Dashboard() {
  const { user, logout } = useAuth();
  const { address, ensName, isConnected, connect, disconnect } = useWeb3();
  const { rooms, isConnected: matrixConnected, sendMessage, createRoom } = useMatrix();
  const { isUploading } = useIPFS();
  
  const [, setLocation] = useLocation();
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [isCreatingRoom, setIsCreatingRoom] = useState(false);

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
      setIsCreatingRoom(true);
      await createRoom(newRoomName);
      setNewRoomName("");
    } catch (err) {
      console.error("Failed to create room:", err);
    } finally {
      setIsCreatingRoom(false);
    }
  };

  const handleSendMessage = async () => {
    if (!messageInput.trim() || !selectedRoom) return;
    try {
      await sendMessage(selectedRoom, messageInput);
      setMessageInput("");
    } catch (err) {
      console.error("Failed to send message:", err);
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
        >
          <Plus className="w-5 h-5" />
        </Button>
      </div>

      {/* Server Channels */}
      <div className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
        <div className="p-4 border-b border-slate-700">
          <h2 className="font-bold text-lg">Channels</h2>
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
                disabled={isCreatingRoom || !newRoomName.trim()}
              >
                Create
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setIsCreatingRoom(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {rooms.map((room) => (
            <button
              key={room.roomId}
              onClick={() => setSelectedRoom(room.roomId)}
              className={`w-full text-left px-4 py-2 rounded-md transition-colors ${
                selectedRoom === room.roomId
                  ? "bg-slate-700 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              <div className="flex items-center gap-2">
                {room.getType() === "m.space" ? (
                  <div className="w-2 h-2 rounded-full bg-purple-500" />
                ) : (
                  <span>#</span>
                )}
                <span className="truncate">{room.name || room.roomId}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="bg-slate-800 border-b border-slate-700 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold">
              {selectedRoom ? "Channel" : "Select a channel"}
            </h1>
            <p className="text-sm text-slate-400">
              {ensName || address?.slice(0, 6) + "..." || "Not connected"}
            </p>
          </div>
          <div className="flex items-center gap-4">
            {!isConnected ? (
              <Button onClick={connect} size="sm">
                Connect Wallet
              </Button>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={disconnect}
                >
                  Disconnect
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => logout()}
            >
              <LogOut className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Messages Area */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-slate-900">
          {selectedRoom ? (
            <div className="text-center text-slate-400">
              <p>Messages will appear here</p>
              <p className="text-sm mt-2">Matrix connection: {matrixConnected ? "✓ Connected" : "✗ Disconnected"}</p>
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-400">
              <p>Select a channel to start messaging</p>
            </div>
          )}
        </div>

        {/* Message Input */}
        {selectedRoom && (
          <div className="bg-slate-800 border-t border-slate-700 p-4">
            <div className="flex gap-2">
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
                disabled={isUploading}
              />
              <Button
                onClick={handleSendMessage}
                disabled={!messageInput.trim() || isUploading}
                size="icon"
              >
                <Send className="w-5 h-5" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                title="Soundboard"
              >
                <Volume2 className="w-5 h-5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Right Sidebar - User Info */}
      <div className="w-64 bg-slate-800 border-l border-slate-700 p-4 overflow-y-auto">
        <div className="space-y-4">
          <Card className="bg-slate-700 border-slate-600 p-4">
            <h3 className="font-bold mb-2">Profile</h3>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-slate-400">Username</p>
                <p className="font-mono">{user.name || user.email}</p>
              </div>
              <div>
                <p className="text-slate-400">Wallet</p>
                <p className="font-mono text-xs">
                  {address ? address.slice(0, 6) + "..." + address.slice(-4) : "Not connected"}
                </p>
              </div>
              {ensName && (
                <div>
                  <p className="text-slate-400">ENS Name</p>
                  <p className="font-mono">{ensName}</p>
                </div>
              )}
            </div>
          </Card>

          <Card className="bg-slate-700 border-slate-600 p-4">
            <h3 className="font-bold mb-2">Status</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${matrixConnected ? "bg-green-500" : "bg-red-500"}`} />
                <span>Matrix: {matrixConnected ? "Connected" : "Disconnected"}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${isConnected ? "bg-green-500" : "bg-red-500"}`} />
                <span>Wallet: {isConnected ? "Connected" : "Disconnected"}</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
