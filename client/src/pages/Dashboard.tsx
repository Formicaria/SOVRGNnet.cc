import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, Plus, Send, LogOut, Hash, Compass, AlertCircle, Paperclip, Download, UserPlus, Trash2, DoorOpen, Check, Copy } from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type TimelineItem =
  | {
      kind: "message";
      id: string;
      dbId: number;
      senderId: number;
      senderName: string | null;
      createdAt: Date;
      content: string;
    }
  | {
      kind: "file";
      id: string;
      senderName: string | null;
      createdAt: Date;
      filename: string;
      ipfsHash: string;
      fileSize: number;
      mimeType: string | null;
    };

export default function Dashboard() {
  const { user, loading, logout } = useAuth();
  const [, setLocation] = useLocation();

  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(null);
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();

  const serversQuery = trpc.servers.list.useQuery(undefined, { enabled: !!user });
  const publicServersQuery = trpc.servers.listPublic.useQuery(undefined, {
    enabled: !!user && discoverOpen,
  });
  const channelsQuery = trpc.channels.listByServer.useQuery(
    { serverId: selectedServerId! },
    { enabled: selectedServerId != null }
  );
  const messagesQuery = trpc.messages.listByChannel.useQuery(
    { channelId: selectedChannelId!, limit: 50 },
    { enabled: selectedChannelId != null, refetchInterval: 3000 }
  );
  const filesQuery = trpc.fileShares.listByChannel.useQuery(
    { channelId: selectedChannelId! },
    { enabled: selectedChannelId != null, refetchInterval: 5000 }
  );

  const createServer = trpc.servers.create.useMutation({
    onSuccess: async res => {
      await utils.servers.list.invalidate();
      setSelectedServerId(res.server.id);
      setSelectedChannelId(res.defaultChannel.id);
      setServerDialogOpen(false);
      setNewServerName("");
    },
    onError: e => setError(e.message),
  });
  const joinServer = trpc.servers.join.useMutation({
    onSuccess: async () => {
      await utils.servers.list.invalidate();
      setDiscoverOpen(false);
    },
    onError: e => setError(e.message),
  });
  const createChannel = trpc.channels.create.useMutation({
    onSuccess: async chan => {
      await utils.channels.listByServer.invalidate({ serverId: selectedServerId! });
      setSelectedChannelId(chan.id);
      setChannelDialogOpen(false);
      setNewChannelName("");
    },
    onError: e => setError(e.message),
  });
  const sendMessage = trpc.messages.send.useMutation({
    onSuccess: async () => {
      setMessageInput("");
      await utils.messages.listByChannel.invalidate({ channelId: selectedChannelId! });
    },
    onError: e => setError(e.message),
  });
  const deleteMessage = trpc.messages.delete.useMutation({
    onSuccess: async () => {
      await utils.messages.listByChannel.invalidate({ channelId: selectedChannelId! });
    },
    onError: e => setError(e.message),
  });
  const createInvite = trpc.servers.createInvite.useMutation({
    onSuccess: res => setInviteCode(res.code),
    onError: e => setError(e.message),
  });
  const leaveServer = trpc.servers.leave.useMutation({
    onSuccess: async () => {
      setSelectedServerId(null);
      setSelectedChannelId(null);
      await utils.servers.list.invalidate();
    },
    onError: e => setError(e.message),
  });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = async (file: File) => {
    if (selectedChannelId == null) return;
    try {
      setIsUploading(true);
      setError(null);
      const res = await fetch(
        `/api/upload?channelId=${selectedChannelId}&filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Upload failed (${res.status})`);
      }
      await utils.fileShares.listByChannel.invalidate({ channelId: selectedChannelId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setIsUploading(false);
    }
  };

  const servers = serversQuery.data ?? [];
  const channels = channelsQuery.data ?? [];
  const messages = messagesQuery.data ?? [];
  const files = filesQuery.data ?? [];

  const timeline: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...messages.map(m => ({
        kind: "message" as const,
        id: `m${m.id}`,
        dbId: m.id,
        senderId: m.userId,
        senderName: m.senderName,
        createdAt: new Date(m.createdAt),
        content: m.content,
      })),
      ...files.map(f => ({
        kind: "file" as const,
        id: `f${f.id}`,
        senderName: f.senderName,
        createdAt: new Date(f.createdAt),
        filename: f.filename,
        ipfsHash: f.ipfsHash,
        fileSize: f.fileSize,
        mimeType: f.mimeType,
      })),
    ];
    return items.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }, [messages, files]);
  const selectedServer = servers.find(s => s.id === selectedServerId) ?? null;
  const selectedChannel = channels.find(c => c.id === selectedChannelId) ?? null;

  // Pick sensible defaults as data arrives.
  useEffect(() => {
    if (selectedServerId == null && servers.length > 0) {
      setSelectedServerId(servers[0].id);
    }
  }, [servers, selectedServerId]);

  useEffect(() => {
    if (
      selectedServerId != null &&
      channels.length > 0 &&
      !channels.some(c => c.id === selectedChannelId)
    ) {
      setSelectedChannelId(channels[0].id);
    }
  }, [channels, selectedServerId, selectedChannelId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [timeline.length]);

  useEffect(() => {
    if (!loading && !user) setLocation("/");
  }, [user, loading, setLocation]);

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-950">
        <Loader2 className="animate-spin text-purple-500" />
      </div>
    );
  }

  const handleSend = () => {
    const content = messageInput.trim();
    if (!content || selectedChannelId == null || sendMessage.isPending) return;
    sendMessage.mutate({ channelId: selectedChannelId, content });
  };

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
      {/* Server rail */}
      <aside className="w-[72px] bg-slate-900 flex flex-col items-center py-3 gap-2 border-r border-slate-800">
        {servers.map(server => (
          <Tooltip key={server.id}>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  setSelectedServerId(server.id);
                  setSelectedChannelId(null);
                }}
                className={`w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-bold transition-all ${
                  server.id === selectedServerId
                    ? "bg-purple-600 rounded-xl"
                    : "bg-slate-800 hover:bg-slate-700 hover:rounded-xl"
                }`}
              >
                {initials(server.name)}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{server.name}</TooltipContent>
          </Tooltip>
        ))}

        <Dialog open={serverDialogOpen} onOpenChange={setServerDialogOpen}>
          <DialogTrigger asChild>
            <button className="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-green-700 hover:rounded-xl flex items-center justify-center transition-all">
              <Plus className="w-5 h-5 text-green-400" />
            </button>
          </DialogTrigger>
          <DialogContent className="bg-slate-900 border-slate-700 text-slate-100">
            <DialogHeader>
              <DialogTitle>Create a server</DialogTitle>
              <DialogDescription>
                A server is your community's space — it starts with a #general channel.
              </DialogDescription>
            </DialogHeader>
            <Input
              value={newServerName}
              onChange={e => setNewServerName(e.target.value)}
              placeholder="Server name"
              className="bg-slate-800 border-slate-700"
              onKeyDown={e => {
                if (e.key === "Enter" && newServerName.trim()) {
                  createServer.mutate({ name: newServerName.trim() });
                }
              }}
            />
            <DialogFooter>
              <Button
                disabled={!newServerName.trim() || createServer.isPending}
                onClick={() => createServer.mutate({ name: newServerName.trim() })}
              >
                {createServer.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Create
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={discoverOpen} onOpenChange={setDiscoverOpen}>
          <DialogTrigger asChild>
            <button className="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-purple-700 hover:rounded-xl flex items-center justify-center transition-all">
              <Compass className="w-5 h-5 text-purple-400" />
            </button>
          </DialogTrigger>
          <DialogContent className="bg-slate-900 border-slate-700 text-slate-100">
            <DialogHeader>
              <DialogTitle>Discover servers</DialogTitle>
              <DialogDescription>Public servers on this instance.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2 max-h-72 overflow-y-auto">
              {(publicServersQuery.data ?? [])
                .filter(s => !servers.some(mine => mine.id === s.id))
                .map(s => (
                  <div
                    key={s.id}
                    className="flex items-center justify-between rounded-lg bg-slate-800 px-3 py-2"
                  >
                    <div>
                      <p className="font-medium">{s.name}</p>
                      {s.description && (
                        <p className="text-xs text-slate-400">{s.description}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      disabled={joinServer.isPending}
                      onClick={() => joinServer.mutate({ serverId: s.id })}
                    >
                      Join
                    </Button>
                  </div>
                ))}
              {publicServersQuery.data &&
                publicServersQuery.data.filter(
                  s => !servers.some(mine => mine.id === s.id)
                ).length === 0 && (
                  <p className="text-sm text-slate-400 text-center py-4">
                    Nothing new to join yet.
                  </p>
                )}
            </div>
          </DialogContent>
        </Dialog>

        <div className="mt-auto">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={async () => {
                  await logout();
                  setLocation("/");
                }}
                className="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-red-900 flex items-center justify-center transition-all"
              >
                <LogOut className="w-4 h-4 text-slate-400" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Log out</TooltipContent>
          </Tooltip>
        </div>
      </aside>

      {/* Channel list */}
      <aside className="w-60 bg-slate-900/60 border-r border-slate-800 flex flex-col">
        <div className="h-12 px-4 flex items-center gap-2 border-b border-slate-800">
          <span className="font-semibold truncate flex-1">
            {selectedServer?.name ?? "SOVRGNnet"}
          </span>
          {selectedServer && selectedServer.ownerId === user.id && (
            <Dialog
              open={inviteOpen}
              onOpenChange={open => {
                setInviteOpen(open);
                if (open && selectedServerId) {
                  setInviteCopied(false);
                  createInvite.mutate({ serverId: selectedServerId });
                }
              }}
            >
              <DialogTrigger asChild>
                <button
                  className="text-slate-400 hover:text-purple-400 transition-colors"
                  title="Invite people"
                >
                  <UserPlus className="w-4 h-4" />
                </button>
              </DialogTrigger>
              <DialogContent className="bg-slate-900 border-slate-700 text-slate-100">
                <DialogHeader>
                  <DialogTitle>Invite people</DialogTitle>
                  <DialogDescription>
                    Anyone with this link can join {selectedServer.name}.
                  </DialogDescription>
                </DialogHeader>
                {inviteCode ? (
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={`${window.location.origin}/invite/${inviteCode}`}
                      className="bg-slate-800 border-slate-700 font-mono text-sm"
                    />
                    <Button
                      size="icon"
                      onClick={async () => {
                        await navigator.clipboard.writeText(
                          `${window.location.origin}/invite/${inviteCode}`
                        );
                        setInviteCopied(true);
                      }}
                    >
                      {inviteCopied ? (
                        <Check className="w-4 h-4" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </Button>
                  </div>
                ) : (
                  <Loader2 className="w-5 h-5 animate-spin text-purple-500" />
                )}
              </DialogContent>
            </Dialog>
          )}
          {selectedServer && selectedServer.ownerId !== user.id && (
            <button
              className="text-slate-400 hover:text-red-400 transition-colors"
              title="Leave server"
              onClick={() =>
                selectedServerId && leaveServer.mutate({ serverId: selectedServerId })
              }
            >
              <DoorOpen className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {channels.map(channel => (
            <button
              key={channel.id}
              onClick={() => setSelectedChannelId(channel.id)}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                channel.id === selectedChannelId
                  ? "bg-slate-700/70 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
            >
              <Hash className="w-4 h-4 shrink-0" />
              <span className="truncate">{channel.name}</span>
            </button>
          ))}
          {selectedServer && selectedServer.ownerId === user.id && (
            <Dialog open={channelDialogOpen} onOpenChange={setChannelDialogOpen}>
              <DialogTrigger asChild>
                <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-slate-500 hover:text-slate-300 hover:bg-slate-800 transition-colors">
                  <Plus className="w-4 h-4" />
                  Add channel
                </button>
              </DialogTrigger>
              <DialogContent className="bg-slate-900 border-slate-700 text-slate-100">
                <DialogHeader>
                  <DialogTitle>Create a channel</DialogTitle>
                </DialogHeader>
                <Input
                  value={newChannelName}
                  onChange={e => setNewChannelName(e.target.value)}
                  placeholder="channel-name"
                  className="bg-slate-800 border-slate-700"
                  onKeyDown={e => {
                    if (e.key === "Enter" && newChannelName.trim() && selectedServerId) {
                      createChannel.mutate({
                        serverId: selectedServerId,
                        name: newChannelName.trim(),
                      });
                    }
                  }}
                />
                <DialogFooter>
                  <Button
                    disabled={!newChannelName.trim() || createChannel.isPending}
                    onClick={() =>
                      selectedServerId &&
                      createChannel.mutate({
                        serverId: selectedServerId,
                        name: newChannelName.trim(),
                      })
                    }
                  >
                    {createChannel.isPending && (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    )}
                    Create
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
        <div className="p-3 border-t border-slate-800 text-xs text-slate-400 truncate">
          {user.name ?? user.email}
        </div>
      </aside>

      {/* Message pane */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-12 px-4 flex items-center gap-2 border-b border-slate-800">
          {selectedChannel ? (
            <>
              <Hash className="w-4 h-4 text-slate-500" />
              <span className="font-semibold">{selectedChannel.name}</span>
            </>
          ) : (
            <span className="text-slate-500">No channel selected</span>
          )}
        </div>

        {error && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded bg-red-950/60 border border-red-900 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
              ✕
            </button>
          </div>
        )}

        <div
          className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 ${
            isDragging ? "outline-2 outline-dashed outline-purple-500 -outline-offset-8 rounded-lg" : ""
          }`}
          onDragOver={e => {
            if (selectedChannelId != null) {
              e.preventDefault();
              setIsDragging(true);
            }
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void uploadFile(file);
          }}
        >
          {servers.length === 0 && (
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 gap-2">
              <p className="text-lg text-slate-300">Welcome to SOVRGNnet.</p>
              <p className="text-sm">
                Create a server with the <Plus className="w-3.5 h-3.5 inline" /> button, or
                find one with <Compass className="w-3.5 h-3.5 inline" /> Discover.
              </p>
            </div>
          )}
          {timeline.map(item => (
            <div key={item.id} className="flex gap-3 group">
              <div className="w-9 h-9 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold shrink-0">
                {initials(item.senderName ?? "?")}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-sm">
                    {item.senderName ?? "Unknown"}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {item.createdAt.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {item.kind === "message" &&
                    (item.senderId === user.id ||
                      selectedServer?.ownerId === user.id) && (
                      <button
                        className="opacity-0 group-hover:opacity-100 text-slate-600 hover:text-red-400 transition-all"
                        title="Delete message"
                        onClick={() => deleteMessage.mutate({ messageId: item.dbId })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                </div>
                {item.kind === "message" ? (
                  <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">
                    {item.content}
                  </p>
                ) : item.mimeType?.startsWith("image/") ? (
                  <a href={`/api/files/${item.ipfsHash}`} target="_blank" rel="noreferrer">
                    <img
                      src={`/api/files/${item.ipfsHash}`}
                      alt={item.filename}
                      className="mt-1 max-w-sm max-h-72 rounded-lg border border-slate-800 object-contain"
                    />
                  </a>
                ) : (
                  <a
                    href={`/api/files/${item.ipfsHash}`}
                    download={item.filename}
                    className="mt-1 flex items-center gap-3 rounded-lg bg-slate-900 border border-slate-800 px-3 py-2 max-w-sm hover:border-purple-700 transition-colors"
                  >
                    <Download className="w-4 h-4 text-purple-400 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm text-slate-200 truncate">
                        {item.filename}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {formatBytes(item.fileSize)}
                      </span>
                    </span>
                  </a>
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {selectedChannel && (
          <div className="p-4 pt-0">
            <div className="flex gap-2 rounded-lg bg-slate-900 border border-slate-800 p-2">
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) void uploadFile(file);
                  e.target.value = "";
                }}
              />
              <Button
                size="icon"
                variant="ghost"
                disabled={isUploading}
                onClick={() => fileInputRef.current?.click()}
                title="Attach a file"
              >
                {isUploading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Paperclip className="w-4 h-4" />
                )}
              </Button>
              <Input
                value={messageInput}
                onChange={e => setMessageInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={`Message #${selectedChannel.name}`}
                className="bg-transparent border-0 focus-visible:ring-0"
              />
              <Button
                size="icon"
                disabled={!messageInput.trim() || sendMessage.isPending}
                onClick={handleSend}
              >
                {sendMessage.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
