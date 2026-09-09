import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Crown,
  Shield,
  ShieldCheck,
  MoreVertical,
  UserMinus,
  Ban,
  Loader2,
} from "lucide-react";
import { trpc } from "@/lib/trpc";

type Role = "owner" | "admin" | "moderator" | "member";

const RANK: Record<Role, number> = { owner: 4, admin: 3, moderator: 2, member: 1 };

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  moderator: "Moderator",
  member: "Member",
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map(w => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function RoleIcon({ role }: { role: Role }) {
  if (role === "owner") return <Crown className="w-3.5 h-3.5 text-amber-400" />;
  if (role === "admin") return <ShieldCheck className="w-3.5 h-3.5 text-purple-400" />;
  if (role === "moderator") return <Shield className="w-3.5 h-3.5 text-sky-400" />;
  return null;
}

export default function MemberList({
  serverId,
  currentUserId,
  onError,
}: {
  serverId: number;
  currentUserId: number;
  onError: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [busyUserId, setBusyUserId] = useState<number | null>(null);
  const [bansOpen, setBansOpen] = useState(false);

  const membersQuery = trpc.serverMembers.list.useQuery(
    { serverId },
    { refetchInterval: 20000 }
  );
  const myRoleQuery = trpc.serverMembers.myRole.useQuery({ serverId });
  // Only while the dialog is showing: a moderator who never opens it shouldn't
  // be polling for a list that is usually empty.
  const bansQuery = trpc.serverMembers.listBans.useQuery(
    { serverId },
    { enabled: bansOpen }
  );

  const refresh = async () => {
    setBusyUserId(null);
    await utils.serverMembers.list.invalidate({ serverId });
  };
  const handleError = (e: { message: string }) => {
    setBusyUserId(null);
    onError(e.message);
  };

  const setRole = trpc.serverMembers.setRole.useMutation({ onSuccess: refresh, onError: handleError });
  const kick = trpc.serverMembers.kick.useMutation({ onSuccess: refresh, onError: handleError });
  const ban = trpc.serverMembers.ban.useMutation({ onSuccess: refresh, onError: handleError });
  const unban = trpc.serverMembers.unban.useMutation({
    onSuccess: async () => {
      setBusyUserId(null);
      await utils.serverMembers.listBans.invalidate({ serverId });
    },
    onError: handleError,
  });

  const members = membersQuery.data ?? [];
  const myRole = (myRoleQuery.data ?? null) as Role | null;

  // Moderator or above, with nobody in particular in mind. The check below is
  // per-target and can't answer "should this person see the ban list at all",
  // which is a question about the actor alone — the server asks it the same way
  // in `listBans`.
  const isModerator = myRole != null && RANK[myRole] >= RANK.moderator;

  // Same rule the server enforces: you can only act on people below you.
  const canModerate = (targetRole: Role, targetUserId: number) =>
    myRole != null &&
    targetUserId !== currentUserId &&
    RANK[myRole] >= RANK.moderator &&
    RANK[myRole] > RANK[targetRole];

  const online = members.filter(m => m.online);
  const offline = members.filter(m => !m.online);

  const row = (m: (typeof members)[number]) => {
    const role = m.role as Role;
    return (
      <div
        key={m.userId}
        className="group flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-800/70 transition-colors"
      >
        <div className="relative shrink-0">
          <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-[11px] font-bold">
            {initials(m.name ?? "?")}
          </div>
          <span
            className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-slate-900 ${
              m.online ? "bg-green-500" : "bg-slate-600"
            }`}
            title={m.online ? "Online" : "Offline"}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`truncate text-sm ${m.online ? "text-slate-200" : "text-slate-500"}`}
            >
              {m.name ?? "Unknown"}
            </span>
            <RoleIcon role={role} />
          </div>
        </div>

        {canModerate(role, m.userId) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="opacity-0 group-hover:opacity-100 text-slate-500 hover:text-slate-200 transition-all"
                disabled={busyUserId === m.userId}
                title="Manage"
              >
                <MoreVertical className="w-4 h-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="bg-slate-900 border-slate-700 text-slate-200">
              <DropdownMenuLabel className="text-xs text-slate-500">
                {m.name ?? "Member"} · {ROLE_LABEL[role]}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-slate-800" />

              {myRole === "owner" && (
                <>
                  {(["admin", "moderator", "member"] as const)
                    .filter(r => r !== role)
                    .map(r => (
                      <DropdownMenuItem
                        key={r}
                        onClick={() => {
                          setBusyUserId(m.userId);
                          setRole.mutate({ serverId, userId: m.userId, role: r });
                        }}
                      >
                        Make {ROLE_LABEL[r].toLowerCase()}
                      </DropdownMenuItem>
                    ))}
                  <DropdownMenuSeparator className="bg-slate-800" />
                </>
              )}

              <DropdownMenuItem
                className="text-amber-400 focus:text-amber-300"
                onClick={() => {
                  setBusyUserId(m.userId);
                  kick.mutate({ serverId, userId: m.userId });
                }}
              >
                <UserMinus className="w-4 h-4 mr-2" />
                Remove from server
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-red-400 focus:text-red-300"
                onClick={() => {
                  setBusyUserId(m.userId);
                  ban.mutate({ serverId, userId: m.userId });
                }}
              >
                <Ban className="w-4 h-4 mr-2" />
                Ban
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  };

  return (
    <aside className="w-56 bg-slate-900/60 border-l border-slate-800 flex flex-col">
      <div className="h-12 px-4 flex items-center gap-2 border-b border-slate-800">
        <span className="flex-1 text-sm font-semibold text-slate-300">
          Members
          <span className="ml-1.5 text-xs text-slate-500">{members.length}</span>
        </span>

        {/*
          The other half of the ban button in the menu below.

          Banning shipped with no way back: `serverMembers.unban` and
          `.listBans` were both implemented and neither had a caller, so the
          only moderation action on this screen that can't be undone by
          repeating it was also the only one with no undo. A moderator who
          banned the wrong account had to ask someone with database access.
        */}
        {isModerator && (
          <Dialog open={bansOpen} onOpenChange={setBansOpen}>
            <DialogTrigger asChild>
              <button
                className="text-slate-500 hover:text-slate-200 transition-colors"
                title="Banned people"
                aria-label="Banned people"
              >
                <Ban className="w-4 h-4" />
              </button>
            </DialogTrigger>
            <DialogContent className="bg-slate-900 border-slate-700 text-slate-100">
              <DialogHeader>
                <DialogTitle>Banned from this server</DialogTitle>
                <DialogDescription className="text-slate-400">
                  A ban keeps someone out of every channel here, invite links
                  included. Lifting one lets them join again the ordinary way —
                  it doesn't put them back in.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2 max-h-72 overflow-y-auto">
                {bansQuery.isLoading && (
                  <Loader2 className="w-5 h-5 animate-spin text-purple-500 mx-auto my-6" />
                )}

                {bansQuery.data?.length === 0 && (
                  <p className="text-sm text-slate-400 text-center py-4">
                    Nobody is banned from this server.
                  </p>
                )}

                {(bansQuery.data ?? []).map(banned => (
                  <div
                    key={banned.userId}
                    className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      {/* A banned account can have no display name, and the
                          left join answers null for one that was deleted
                          outright. The id is the thing that always exists and
                          is what a moderator can match against an audit log. */}
                      <p className="text-sm truncate">
                        {banned.name ?? `Account #${banned.userId}`}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate">
                        {banned.reason ?? "No reason recorded"} ·{" "}
                        {new Date(banned.createdAt).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-slate-700 text-xs"
                      disabled={busyUserId === banned.userId}
                      onClick={() => {
                        setBusyUserId(banned.userId);
                        unban.mutate({ serverId, userId: banned.userId });
                      }}
                    >
                      {busyUserId === banned.userId && (
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
                      )}
                      Lift ban
                    </Button>
                  </div>
                ))}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {online.length > 0 && (
          <>
            <p className="px-2 pt-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Online — {online.length}
            </p>
            {online.map(row)}
          </>
        )}
        {offline.length > 0 && (
          <>
            <p className="px-2 pt-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
              Offline — {offline.length}
            </p>
            {offline.map(row)}
          </>
        )}
        {members.length === 0 && (
          <p className="px-2 py-4 text-xs text-slate-500 text-center">
            Just you so far. Share an invite link.
          </p>
        )}
      </div>
    </aside>
  );
}
