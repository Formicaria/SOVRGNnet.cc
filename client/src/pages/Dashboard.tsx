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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Loader2,
  Plus,
  Menu,
  Send,
  LogOut,
  Hash,
  Volume2,
  Compass,
  AlertCircle,
  Paperclip,
  Download,
  UserPlus,
  Trash2,
  DoorOpen,
  Check,
  Copy,
  Pencil,
  SmilePlus,
  X,
  Globe,
  Settings,
  KeyRound,
  Lock,
} from "lucide-react";
import { useState, useEffect, useMemo, useRef } from "react";
import { useLocation } from "wouter";
import { trpc } from "@/lib/trpc";
import VoicePanel from "@/components/VoicePanel";
import MemberList from "@/components/MemberList";
import AddServerDialog from "@/components/AddServerDialog";
import ServerSettings from "@/components/ServerSettings";
import { EncryptionPanel } from "@/components/EncryptionPanel";
import { SharedFile } from "@/components/SharedFile";
import { useConnections } from "@/contexts/ConnectionsContext";
import { useMatrixSession } from "@/hooks/useMatrixSession";
import { encryptAttachment } from "@shared/attachments";
import type { MessageCryptoState } from "@shared/e2ee";

/** Reactions people actually reach for, without shipping an emoji picker. */
const QUICK_REACTIONS = ["👍", "😂", "🔥", "❤️", "👀", "🎉"] as const;

/** Remembers that the recovery prompt has been shown on this browser. */
const ENCRYPTION_PROMPTED_KEY = "sovrgn.encryption.prompted";

type ReactionMap = Record<string, number[]>;

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
      /** Null for federated senders — a Matrix id without a local account. */
      senderId: number | null;
      senderName: string | null;
      createdAt: Date;
      content: string;
      /**
       * How this message stands with the crypto machine. Never just
       * "encrypted": a message that decrypted and one whose key never arrived
       * are the same row in the index and must not look the same on screen.
       */
      cryptoState: MessageCryptoState;
      /** What to show instead of content when there is no content to show. */
      cryptoDetail: string;
      editedAt: Date | null;
      reactions: ReactionMap;
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
  const { connections, current, multiplexes } = useConnections();
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [, setLocation] = useLocation();

  const [selectedServerId, setSelectedServerId] = useState<number | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<number | null>(
    null
  );
  /**
   * Whether the navigation drawer is open. Only meaningful under `md`: on
   * wider screens the rail and channel list are static columns and this state
   * is ignored by the classes that read it. It exists because the dashboard
   * shipped with zero responsive behaviour — four fixed columns rendered into
   * a phone, and "works in any browser" was false on the browser strangers
   * actually open invite links in.
   */
  const [navOpen, setNavOpen] = useState(false);
  const [messageInput, setMessageInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [discoverOpen, setDiscoverOpen] = useState(false);
  const [newServerName, setNewServerName] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelVoice, setNewChannelVoice] = useState(false);
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const utils = trpc.useUtils();

  const serversQuery = trpc.servers.list.useQuery(undefined, {
    enabled: !!user,
  });
  const publicServersQuery = trpc.servers.listPublic.useQuery(undefined, {
    enabled: !!user && discoverOpen,
  });
  const channelsQuery = trpc.channels.listByServer.useQuery(
    { serverId: selectedServerId! },
    { enabled: selectedServerId != null }
  );
  // Live updates and encryption over the client's own Matrix session where the
  // instance offers it (ADR 0008 stages 3 and 4); the intervals below stay as
  // the fallback for instances whose homeserver isn't publicly reachable.
  const roomToChannelRef = useRef<Map<string, number>>(new Map());
  const {
    live: syncLive,
    canAuthor,
    encryptionAvailable,
    session: cryptoSession,
    cryptoReady,
    revision: cryptoRevision,
    pendingVerification,
    clearPendingVerification,
    send: sendOverMatrix,
    sendFile: sendFileOverMatrix,
    attachmentFor,
    lookup: lookupPlaintext,
    backfill,
  } = useMatrixSession(!!user, event => {
    const channelId = roomToChannelRef.current.get(event.roomId);
    if (channelId == null) return;

    // Stage 3 read the content to tell a file notice from a text message and
    // refetched only the list that changed. In an encrypted room the wire type
    // is `m.room.encrypted` and there is no content to read — the whole point
    // — so the split can't survive. Both lists are refetched instead: one
    // wasted request beats a file share that never appears.
    if (
      event.type === "m.room.message" ||
      event.type === "m.room.encrypted" ||
      event.type === "m.room.redaction"
    ) {
      void utils.messages.listByChannel.invalidate({ channelId });
      void utils.fileShares.listByChannel.invalidate({ channelId });
    }
  });
  const [encryptionPanelOpen, setEncryptionPanelOpen] = useState(false);
  const [encryptionFirstRun, setEncryptionFirstRun] = useState(false);

  const messagesQuery = trpc.messages.listByChannel.useQuery(
    { channelId: selectedChannelId!, limit: 50 },
    {
      enabled: selectedChannelId != null,
      refetchInterval: syncLive ? false : 3000,
    }
  );
  const filesQuery = trpc.fileShares.listByChannel.useQuery(
    { channelId: selectedChannelId! },
    {
      enabled: selectedChannelId != null,
      refetchInterval: syncLive ? false : 5000,
    }
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
      await utils.channels.listByServer.invalidate({
        serverId: selectedServerId!,
      });
      setSelectedChannelId(chan.id);
      setChannelDialogOpen(false);
      setNewChannelName("");
    },
    onError: e => setError(e.message),
  });
  const enableEncryption = trpc.channels.enableEncryption.useMutation({
    onSuccess: async () => {
      await utils.channels.listByServer.invalidate({
        serverId: selectedServerId!,
      });
      // Opened straight afterwards because encrypting a channel is the moment
      // a recovery key stops being optional, and the person who just did it is
      // the one who most needs to be told.
      setEncryptionPanelOpen(true);
    },
    onError: e => setError(e.message),
  });
  const sendMessage = trpc.messages.send.useMutation({
    onSuccess: async () => {
      setMessageInput("");
      await utils.messages.listByChannel.invalidate({
        channelId: selectedChannelId!,
      });
    },
    onError: e => setError(e.message),
  });
  const deleteMessage = trpc.messages.delete.useMutation({
    onSuccess: async () => {
      await utils.messages.listByChannel.invalidate({
        channelId: selectedChannelId!,
      });
    },
    onError: e => setError(e.message),
  });
  const editMessage = trpc.messages.edit.useMutation({
    onSuccess: async () => {
      setEditingId(null);
      setEditDraft("");
      await utils.messages.listByChannel.invalidate({
        channelId: selectedChannelId!,
      });
    },
    onError: e => setError(e.message),
  });
  const reactToMessage = trpc.messages.react.useMutation({
    onSuccess: async () => {
      await utils.messages.listByChannel.invalidate({
        channelId: selectedChannelId!,
      });
    },
    onError: e => setError(e.message),
  });
  const setTyping = trpc.channels.setTyping.useMutation();
  const typingQuery = trpc.channels.whoIsTyping.useQuery(
    { channelId: selectedChannelId! },
    { enabled: selectedChannelId != null, refetchInterval: 3000 }
  );
  const myRoleQuery = trpc.serverMembers.myRole.useQuery(
    { serverId: selectedServerId! },
    { enabled: selectedServerId != null }
  );

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const typingSentAt = useRef(0);

  // Announce typing at most once every four seconds — the server keeps the
  // flag alive for six, so this is enough to look continuous without
  // hammering the API on every keystroke.
  const announceTyping = () => {
    if (selectedChannelId == null) return;
    const now = Date.now();
    if (now - typingSentAt.current < 4000) return;
    typingSentAt.current = now;
    setTyping.mutate({ channelId: selectedChannelId, typing: true });
  };
  const createInvite = trpc.servers.createInvite.useMutation({
    // Prefer the server's own idea of its address — behind a tunnel it knows
    // better than the browser does — but fall back to the current origin.
    onSuccess: res =>
      setInviteLink(res.url ?? `${window.location.origin}/invite/${res.code}`),
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
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  /**
   * Upload a file, encrypting the bytes first when the channel is encrypted.
   *
   * The order matters and is not the obvious one. The bytes are encrypted in
   * this browser *before* the upload, so the instance stores and pins
   * ciphertext and never holds a readable copy — and then the key is published
   * in a room event the instance also can't read. If those were reversed, or
   * if the announcement went through the API like it does for plaintext
   * channels, the instance would hold both halves and the lock icon would be
   * decoration.
   *
   * Filename, size and MIME type still go to the index in the clear. That is
   * how the file list works, it is metadata the threat model already concedes,
   * and it is written down rather than left to be discovered.
   */
  const uploadFile = async (file: File) => {
    if (selectedChannelId == null) return;
    const channel = channels.find(c => c.id === selectedChannelId);
    const encrypt = channel?.encrypted === true;

    try {
      setIsUploading(true);
      setError(null);

      if (encrypt && !canAuthor) {
        // Same refusal as sending a message into an encrypted channel: without
        // its own session this client cannot publish the key, so an upload
        // would leave bytes nobody can ever open.
        throw new Error(
          "This channel is encrypted, and this client isn't holding its own Matrix " +
            "session. Reload, or upload from a device that can."
        );
      }

      const plaintext = new Uint8Array(await file.arrayBuffer());
      const sealed = encrypt ? await encryptAttachment(plaintext) : null;

      const res = await fetch(
        `/api/upload?channelId=${selectedChannelId}&filename=${encodeURIComponent(file.name)}`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: new Uint8Array(sealed ? sealed.ciphertext : plaintext),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? `Upload failed (${res.status})`);
      }
      const share = (await res.json()) as {
        id?: number;
        ipfsHash?: string;
        fileSize?: number;
      };

      if (sealed && channel?.matrixRoomId && share.ipfsHash) {
        // The instance skips the notice for encrypted channels, so this event
        // is the only announcement *and* the only copy of the key. The bytes
        // are already pinned — they had to be, the CID doesn't exist until the
        // upload finishes — so a failure here would leave ciphertext that
        // nobody can ever open, including the person who just uploaded it.
        //
        // Try once more, and if that fails too, take the bytes back out. A
        // visible failure the user can retry beats a file that sits in the
        // list looking fine and is permanently unreadable.
        const announce = () =>
          sendFileOverMatrix(channel.matrixRoomId, {
            filename: file.name,
            cid: share.ipfsHash!,
            size: share.fileSize ?? plaintext.length,
            mimeType: file.type || null,
            encryption: sealed.info,
          });

        try {
          await announce();
        } catch {
          try {
            await announce();
          } catch {
            if (share.id !== undefined) {
              await fetch(`/api/uploads/${share.id}`, {
                method: "DELETE",
                credentials: "include",
              }).catch(() => {
                // The bytes outlive the attempt. Logged rather than shown:
                // there's nothing the person can do about it, and they already
                // have an error they *can* act on.
                console.warn("[upload] couldn't abandon the orphaned upload");
              });
            }
            throw new Error(
              "That file uploaded, but its key couldn't be shared — it would have " +
                "been unreadable by everyone. It's been removed. Try again."
            );
          }
        }
      }

      await utils.fileShares.listByChannel.invalidate({
        channelId: selectedChannelId,
      });
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

  // Sync events arrive addressed by Matrix room id; queries are keyed by
  // channel id. Keep the translation current as channel lists load.
  useEffect(() => {
    for (const channel of channels) {
      roomToChannelRef.current.set(channel.matrixRoomId, channel.id);
    }
  }, [channels]);

  /**
   * Where the index meets the plaintext.
   *
   * ADR 0009 made the instance's database an index built from Matrix, and
   * stage 4's groundwork made it store `m.room.encrypted` content-blind. Both
   * were right, and together they mean the index can order an encrypted
   * conversation, name its senders and timestamp it, while being structurally
   * incapable of rendering a word of it. That is not a gap to close — an index
   * that could render it would be an index the operator can read.
   *
   * So content for an encrypted row comes from the crypto machine, joined on
   * the Matrix event id the index does keep. When the machine has no plaintext
   * the row still exists and says why, which is the difference between a
   * conversation with a hole in it and a conversation that silently skips a
   * message.
   */
  const timeline: TimelineItem[] = useMemo(() => {
    const items: TimelineItem[] = [
      ...messages.map(m => {
        const decrypted = m.encrypted
          ? lookupPlaintext(m.matrixEventId)
          : undefined;
        return {
          kind: "message" as const,
          id: `m${m.id}`,
          dbId: m.id,
          senderId: m.userId,
          senderName: m.senderName,
          createdAt: new Date(m.createdAt),
          content: m.encrypted ? (decrypted?.body ?? "") : m.content,
          cryptoState: !m.encrypted
            ? ("plaintext" as const)
            : (decrypted?.verdict.state ?? ("pending" as const)),
          cryptoDetail: !m.encrypted
            ? ""
            : (decrypted?.verdict.detail ??
              // No entry at all means the event hasn't reached this client's
              // timeline yet, which is a different thing from a decryption
              // failure and resolves itself within a sync.
              "Waiting for this message to reach this device."),
          editedAt: m.editedAt ? new Date(m.editedAt) : null,
          reactions: (m.reactions as ReactionMap | null) ?? {},
        };
      }),
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
    // `cryptoRevision` is the dependency that matters: a room key arriving
    // changes what `lookupPlaintext` returns without changing `messages`.
  }, [messages, files, lookupPlaintext, cryptoRevision]);
  const selectedServer = servers.find(s => s.id === selectedServerId) ?? null;
  const selectedChannel =
    channels.find(c => c.id === selectedChannelId) ?? null;

  /**
   * Pull the room's own timeline when an encrypted channel is opened.
   *
   * The index knows an encrypted message exists; only the timeline carries the
   * ciphertext to decrypt. Without this, opening an encrypted channel shows
   * rows that say "waiting" for everything older than this session's first
   * sync — permanently, because nothing would ever go and fetch them.
   */
  useEffect(() => {
    if (!selectedChannel?.encrypted || !selectedChannel.matrixRoomId) return;
    void backfill(selectedChannel.matrixRoomId);
  }, [
    selectedChannel?.id,
    selectedChannel?.encrypted,
    selectedChannel?.matrixRoomId,
    backfill,
  ]);

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

  /**
   * Ask about recovery once, on the first session that could set it up.
   *
   * Every channel on a capable instance is encrypted, which makes a recovery
   * key the difference between "my messages are private" and "my messages are
   * gone when I clear my browser". Leaving that behind a key icon most people
   * never click would make encryption-by-default a data-loss default.
   *
   * Once per browser, not once per load: `cryptoReady` is null until the
   * readiness check answers, so this waits for a definite false rather than
   * firing on a loading state, and the flag is written whether they set it up
   * or skipped. The amber badge keeps asking afterwards.
   */
  useEffect(() => {
    if (!encryptionAvailable || cryptoReady !== false) return;
    if (localStorage.getItem(ENCRYPTION_PROMPTED_KEY)) return;
    localStorage.setItem(ENCRYPTION_PROMPTED_KEY, "1");
    setEncryptionFirstRun(true);
    setEncryptionPanelOpen(true);
  }, [encryptionAvailable, cryptoReady]);

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

    const selected = channels.find(c => c.id === selectedChannelId);
    const roomId = selected?.matrixRoomId;

    // An encrypted channel has exactly one send path, and no fallback.
    //
    // Everywhere else in this function a failure falls back to the API, on the
    // principle that a message shouldn't be lost to an architectural
    // preference. Here that principle inverts: the API path composes plaintext
    // server-side, and falling back to it would put cleartext into a room
    // whose members believe it is encrypted. Refusing is the safe failure.
    if (selected?.encrypted) {
      if (!canAuthor || !roomId) {
        setError(
          "This channel is encrypted, and this client isn't holding its own Matrix " +
            "session. Reload, or open it on a device that can."
        );
        return;
      }
      typingSentAt.current = 0;
      setTyping.mutate({ channelId: selectedChannelId, typing: false });
      setMessageInput("");
      void sendOverMatrix(roomId, content).catch(() => {
        setMessageInput(content);
        setError("That message wasn't sent. Nothing was sent unencrypted.");
      });
      return;
    }

    typingSentAt.current = 0;
    setTyping.mutate({ channelId: selectedChannelId, typing: false });

    // Author over the client's own Matrix session when the instance both
    // offers direct sync and records homeserver pushes (ADR 0009). The row
    // appears via the appservice ingest and the echo returns through /sync.
    // Any failure falls back to the API path — the message must not be lost
    // to an architectural preference.
    if (canAuthor && roomId) {
      setMessageInput("");
      void sendOverMatrix(roomId, content).catch(() => {
        sendMessage.mutate({ channelId: selectedChannelId, content });
      });
      return;
    }
    sendMessage.mutate({ channelId: selectedChannelId, content });
  };

  const myRole = myRoleQuery.data ?? null;
  const canModerate =
    myRole === "owner" || myRole === "admin" || myRole === "moderator";
  const canManageServer = myRole === "owner" || myRole === "admin";
  const typingNames = (typingQuery.data ?? []).map(t => t.name);
  const typingLabel =
    typingNames.length === 0
      ? null
      : typingNames.length === 1
        ? `${typingNames[0]} is typing…`
        : typingNames.length === 2
          ? `${typingNames[0]} and ${typingNames[1]} are typing…`
          : "Several people are typing…";

  // h-dvh, not h-screen: on phones 100vh includes the space under the browser
  // chrome, which put the composer behind the URL bar. Dynamic viewport height
  // is what "the visible screen" actually means there; identical on desktop.
  return (
    <div className="flex h-dvh bg-slate-950 text-slate-100 overflow-hidden">
      {navOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setNavOpen(false)}
          aria-hidden
        />
      )}

      {/* Under `md` the rail and channel list become one off-canvas drawer —
          a phone gets one pane at a time, which is the entire responsive
          design. At `md` and up this wrapper degrades to a plain flex row and
          navOpen is ignored, so the desktop layout is byte-for-byte what it
          was before phones were considered. */}
      <div
        className={`${
          navOpen ? "translate-x-0" : "-translate-x-full"
        } fixed inset-y-0 left-0 z-40 flex transition-transform duration-200 md:static md:z-auto md:translate-x-0 md:transition-none`}
      >
      {/* Server rail. The strip at the top is *hosts* — different machines
          people run — and below it, the communities on the current host. */}
      <aside className="w-[72px] bg-slate-900 flex flex-col items-center py-3 gap-2 border-r border-slate-800">
        {connections.length > 1 && (
          <>
            {connections.map(connection => {
              const active = connection.id === current?.id;
              return (
                <Tooltip key={connection.id}>
                  <TooltipTrigger asChild>
                    <button
                      // The host belongs in the name here, not just the
                      // tooltip: two connections can share a display name and
                      // the thing that distinguishes them — which machine you
                      // are about to be sent to — is the part only sighted
                      // hover reveals.
                      aria-label={`${connection.name} (${connection.host})`}
                      onClick={() => {
                        if (active) return;
                        // In a browser, another server is another origin with
                        // its own session — switching means going there.
                        if (!multiplexes) {
                          window.location.href = `${connection.secure ? "https" : "http"}://${connection.host}`;
                        }
                      }}
                      className={`w-9 h-9 rounded-lg flex items-center justify-center text-[11px] font-bold transition-all ${
                        active
                          ? "bg-slate-700 text-white ring-2 ring-purple-500"
                          : "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                      }`}
                    >
                      {initials(connection.name)}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <span className="font-medium">{connection.name}</span>
                    <span className="block text-[11px] opacity-70">
                      {connection.host}
                    </span>
                  </TooltipContent>
                </Tooltip>
              );
            })}
            <div className="w-8 h-px bg-slate-700 my-1" />
          </>
        )}

        {servers.map(server => (
          <Tooltip key={server.id}>
            <TooltipTrigger asChild>
              <button
                // The visible label is two initials, which is a name in the
                // strict sense and useless as one — "E C button" tells you
                // nothing about which server you are about to switch to.
                aria-label={server.name}
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
                A server is your community's space — it starts with a #general
                channel.
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
                onClick={() =>
                  createServer.mutate({ name: newServerName.trim() })
                }
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
              <DialogDescription>
                Public servers on this instance.
              </DialogDescription>
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
                        <p className="text-xs text-slate-400">
                          {s.description}
                        </p>
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

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label="Add another server"
              onClick={() => setAddServerOpen(true)}
              className="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-slate-700 hover:rounded-xl flex items-center justify-center transition-all"
            >
              <Globe className="w-5 h-5 text-sky-400" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">Add another server</TooltipContent>
        </Tooltip>
        <AddServerDialog open={addServerOpen} onOpenChange={setAddServerOpen} />

        {/* Instance administration, for whoever runs this server. */}
        {user.role === "admin" && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label="Server settings"
                  onClick={() => setSettingsOpen(true)}
                  className="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-slate-700 hover:rounded-xl flex items-center justify-center transition-all"
                >
                  <Settings className="w-5 h-5 text-slate-400" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Server settings</TooltipContent>
            </Tooltip>
            <ServerSettings
              open={settingsOpen}
              onOpenChange={setSettingsOpen}
            />
          </>
        )}

        <div className="mt-auto flex flex-col gap-2">
          {encryptionAvailable && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  // Every icon-only button in this rail had its only label in
                  // the tooltip below it, and a tooltip is not a name: Radix
                  // renders it into the DOM on hover and removes it again, so
                  // at rest the control announces as "button" and nothing
                  // else. Hovering is not something a screen reader does.
                  //
                  // Of the six, this is the one that matters most. It is the
                  // only route to device verification and to setting up a
                  // recovery key — the two things standing between a user and
                  // silently losing every message they have received. An
                  // unnamed button is a locked door for anyone not using a
                  // mouse, and we locked it in front of the security setup.
                  //
                  // Found by the browser stage, asking for this button by name
                  // and being told there wasn't one. The accessibility tree it
                  // dumped on failure is the same tree assistive tech reads.
                  aria-label="Encryption"
                  onClick={() => setEncryptionPanelOpen(true)}
                  className="w-12 h-12 rounded-2xl bg-slate-800 hover:bg-slate-700 hover:rounded-xl flex items-center justify-center transition-all relative"
                >
                  <KeyRound className="w-4 h-4 text-slate-400" />
                  {/* Shown only when setup is actually incomplete. A badge
                      that is always on is a badge nobody reads, and this one
                      is the only prompt to do the thing the whole stage
                      depends on people doing. */}
                  {cryptoReady === false && (
                    <span className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-amber-400" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Encryption</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Log out"
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
          {selectedServer && canManageServer && (
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
                {inviteLink ? (
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={inviteLink}
                      className="bg-slate-800 border-slate-700 font-mono text-sm"
                    />
                    <Button
                      size="icon"
                      onClick={async () => {
                        await navigator.clipboard.writeText(inviteLink);
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
                selectedServerId &&
                leaveServer.mutate({ serverId: selectedServerId })
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
              onClick={() => {
                setSelectedChannelId(channel.id);
                // Picking a channel is the drawer's exit on a phone — leaving
                // it open would cover the conversation just chosen.
                setNavOpen(false);
              }}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                channel.id === selectedChannelId
                  ? "bg-slate-700/70 text-white"
                  : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
              }`}
            >
              {channel.type !== "text" ? (
                <Volume2 className="w-4 h-4 shrink-0" />
              ) : (
                <Hash className="w-4 h-4 shrink-0" />
              )}
              <span className="truncate">{channel.name}</span>
              {channel.encrypted && (
                <span
                  className="ml-auto text-[10px] text-slate-500"
                  title="End-to-end encrypted room"
                >
                  🔒
                </span>
              )}
            </button>
          ))}
          {selectedServer && canManageServer && (
            <Dialog
              open={channelDialogOpen}
              onOpenChange={setChannelDialogOpen}
            >
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
                    if (
                      e.key === "Enter" &&
                      newChannelName.trim() &&
                      selectedServerId
                    ) {
                      createChannel.mutate({
                        serverId: selectedServerId,
                        name: newChannelName.trim(),
                        type: newChannelVoice ? ("voice" as const) : ("text" as const),
                      });
                    }
                  }}
                />
                <label className="flex items-center gap-2 mt-3 text-sm text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newChannelVoice}
                    onChange={e => setNewChannelVoice(e.target.checked)}
                  />
                  Voice channel — people talk here instead of typing
                </label>
                <DialogFooter>
                  <Button
                    disabled={!newChannelName.trim() || createChannel.isPending}
                    onClick={() =>
                      selectedServerId &&
                      createChannel.mutate({
                        serverId: selectedServerId,
                        name: newChannelName.trim(),
                        type: newChannelVoice ? ("voice" as const) : ("text" as const),
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
      </div>

      {/* Message pane */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-12 px-4 flex items-center gap-2 border-b border-slate-800">
          {/* The way back to the drawer on a phone; does not exist at md+. */}
          <button
            className="md:hidden -ml-2 p-2 text-slate-400 hover:text-slate-100"
            onClick={() => setNavOpen(true)}
            aria-label="Open communities and channels"
          >
            <Menu className="w-5 h-5" />
          </button>
          {selectedChannel ? (
            <>
              {selectedChannel.type !== "text" ? (
                <Volume2 className="w-4 h-4 text-slate-500" />
              ) : (
                <Hash className="w-4 h-4 text-slate-500" />
              )}
              <span className="font-semibold">{selectedChannel.name}</span>
              {selectedChannel.encrypted ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="flex items-center gap-1 text-xs text-emerald-400">
                      <Lock className="w-3.5 h-3.5" />
                      Encrypted
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    Messages here are readable only on the devices of people in
                    this channel. Whoever runs this instance stores them, and
                    can't read them.
                  </TooltipContent>
                </Tooltip>
              ) : (
                canManageServer &&
                encryptionAvailable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto h-7 text-xs text-slate-400 hover:text-slate-100"
                    disabled={enableEncryption.isPending}
                    onClick={() => {
                      // Irreversible, so it asks. Matrix has no way to
                      // un-encrypt a room and the messages sent afterwards
                      // stay ciphertext forever.
                      if (
                        !window.confirm(
                          `Encrypt #${selectedChannel.name}?\n\n` +
                            "This can't be undone. Messages sent afterwards are readable " +
                            "only on members' own devices — this instance will store them " +
                            "and be unable to read them. Anyone whose client can't hold " +
                            "keys will stop being able to read the channel."
                        )
                      ) {
                        return;
                      }
                      enableEncryption.mutate({
                        channelId: selectedChannel.id,
                      });
                    }}
                  >
                    {enableEncryption.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Lock className="w-3.5 h-3.5" />
                    )}
                    Encrypt this channel
                  </Button>
                )
              )}
            </>
          ) : (
            <span className="text-slate-500">No channel selected</span>
          )}
        </div>

        {error && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded bg-red-950/60 border border-red-900 px-3 py-2 text-sm text-red-300">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-200"
            >
              ✕
            </button>
          </div>
        )}

        {selectedChannel && selectedChannel.type !== "text" ? (
          <VoicePanel
            key={selectedChannel.id}
            channelId={selectedChannel.id}
            channelName={selectedChannel.name}
          />
        ) : (
        <>
        <div
          className={`flex-1 overflow-y-auto px-4 py-3 space-y-3 ${
            isDragging
              ? "outline-2 outline-dashed outline-purple-500 -outline-offset-8 rounded-lg"
              : ""
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
            <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 gap-3">
              {user.role === "admin" ? (
                <>
                  {/* The first account on an instance lands here having just
                      set the whole thing up. Say so, and say what's next —
                      this is the one moment they're guaranteed to be looking. */}
                  <p className="text-lg text-slate-300">
                    Your instance is running, and you're its administrator.
                  </p>
                  <div className="text-sm max-w-md space-y-1.5 text-left">
                    <p>
                      <Plus className="w-3.5 h-3.5 inline mr-1" />
                      Create your first community — it starts with a #general
                      channel.
                    </p>
                    <p>
                      <UserPlus className="w-3.5 h-3.5 inline mr-1" />
                      Invite people from the community header once it exists.
                    </p>
                    <p>
                      <Settings className="w-3.5 h-3.5 inline mr-1" />
                      Server settings holds your instance's name, join policy,
                      health, and members.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-lg text-slate-300">Welcome.</p>
                  <p className="text-sm">
                    Create a server with the{" "}
                    <Plus className="w-3.5 h-3.5 inline" /> button, or find one
                    with <Compass className="w-3.5 h-3.5 inline" /> Discover.
                  </p>
                </>
              )}
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
                  {item.kind === "message" && item.editedAt && (
                    <span className="text-[10px] text-slate-600" title="Edited">
                      (edited)
                    </span>
                  )}
                  {item.kind === "message" && (
                    <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-all">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="text-slate-600 hover:text-purple-400"
                            title="Add reaction"
                          >
                            <SmilePlus className="w-3.5 h-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="bg-slate-900 border-slate-700 flex gap-1 p-1.5 min-w-0"
                        >
                          {QUICK_REACTIONS.map(emoji => (
                            <button
                              key={emoji}
                              className="text-base leading-none px-1.5 py-1 rounded hover:bg-slate-800 transition-colors"
                              onClick={() =>
                                reactToMessage.mutate({
                                  messageId: item.dbId,
                                  emoji,
                                })
                              }
                            >
                              {emoji}
                            </button>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {item.senderId === user.id && (
                        <button
                          className="text-slate-600 hover:text-sky-400"
                          title="Edit message"
                          onClick={() => {
                            setEditingId(item.dbId);
                            setEditDraft(item.content);
                          }}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}

                      {(item.senderId === user.id || canModerate) && (
                        <button
                          className="text-slate-600 hover:text-red-400"
                          title="Delete message"
                          onClick={() =>
                            deleteMessage.mutate({ messageId: item.dbId })
                          }
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {item.kind === "message" ? (
                  editingId === item.dbId ? (
                    <div className="mt-1 flex gap-2">
                      <Input
                        autoFocus
                        value={editDraft}
                        onChange={e => setEditDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            if (editDraft.trim()) {
                              editMessage.mutate({
                                messageId: item.dbId,
                                content: editDraft.trim(),
                              });
                            }
                          }
                          if (e.key === "Escape") {
                            setEditingId(null);
                            setEditDraft("");
                          }
                        }}
                        className="bg-slate-800 border-slate-700 h-8 text-sm"
                      />
                      <Button
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        disabled={!editDraft.trim() || editMessage.isPending}
                        onClick={() =>
                          editMessage.mutate({
                            messageId: item.dbId,
                            content: editDraft.trim(),
                          })
                        }
                      >
                        <Check className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        onClick={() => {
                          setEditingId(null);
                          setEditDraft("");
                        }}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  ) : item.kind === "message" &&
                    item.cryptoState !== "plaintext" &&
                    !item.content ? (
                    // Encrypted and not readable here. The three states are
                    // rendered differently on purpose: "pending" resolves by
                    // itself, "recoverable" is something the reader can act
                    // on, and "lost" is a hole they should stop waiting for.
                    <p
                      className={`flex items-center gap-1.5 text-sm italic ${
                        item.cryptoState === "recoverable"
                          ? "text-amber-500"
                          : "text-slate-500"
                      }`}
                    >
                      <Lock className="w-3.5 h-3.5 shrink-0" />
                      <span>{item.cryptoDetail}</span>
                      {item.cryptoState === "recoverable" && (
                        <button
                          onClick={() => setEncryptionPanelOpen(true)}
                          className="not-italic underline underline-offset-2 hover:text-amber-400"
                        >
                          Fix
                        </button>
                      )}
                    </p>
                  ) : (
                    <>
                      <p className="text-sm text-slate-200 whitespace-pre-wrap break-words">
                        {item.content}
                      </p>
                      {Object.keys(item.reactions).length > 0 && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {Object.entries(item.reactions).map(
                            ([emoji, userIds]) => {
                              const mine = userIds.includes(user.id);
                              return (
                                <button
                                  key={emoji}
                                  onClick={() =>
                                    reactToMessage.mutate({
                                      messageId: item.dbId,
                                      emoji,
                                    })
                                  }
                                  className={`flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors ${
                                    mine
                                      ? "border-purple-600 bg-purple-950/60 text-purple-200"
                                      : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600"
                                  }`}
                                  title={
                                    mine ? "Click to remove" : "Click to add"
                                  }
                                >
                                  <span className="leading-none">{emoji}</span>
                                  <span className="leading-none">
                                    {userIds.length}
                                  </span>
                                </button>
                              );
                            }
                          )}
                        </div>
                      )}
                    </>
                  )
                ) : (
                  <SharedFile
                    cid={item.ipfsHash}
                    filename={item.filename}
                    fileSize={item.fileSize}
                    mimeType={item.mimeType}
                    // In an encrypted channel the key rides in the room event,
                    // so the index can list the file and only a device holding
                    // room keys can open it. In a plaintext channel there is
                    // nothing to look up and the browser fetches it directly.
                    encryption={
                      selectedChannel?.encrypted
                        ? attachmentFor(item.ipfsHash)
                        : null
                    }
                    formatBytes={formatBytes}
                  />
                )}
              </div>
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {selectedChannel && (
          <div className="p-4 pt-0 pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="h-5 px-1 text-xs text-slate-500 italic">
              {typingLabel}
            </div>
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
                onChange={e => {
                  setMessageInput(e.target.value);
                  if (e.target.value) announceTyping();
                }}
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
        </>
        )}
      </main>

      {selectedServerId != null && (
        <MemberList
          serverId={selectedServerId}
          currentUserId={user.id}
          onError={setError}
        />
      )}

      {/* Mounted regardless of the button, because a verification request from
          another device has to be able to open it on its own. */}
      <EncryptionPanel
        open={encryptionPanelOpen}
        onOpenChange={open => {
          setEncryptionPanelOpen(open);
          if (!open) setEncryptionFirstRun(false);
        }}
        session={cryptoSession}
        revision={cryptoRevision}
        incoming={pendingVerification}
        onIncomingHandled={clearPendingVerification}
        firstRun={encryptionFirstRun}
      />
    </div>
  );
}
