import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Crown, Shield, ShieldCheck, MoreVertical, UserMinus, Ban } from "lucide-react";
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

  const membersQuery = trpc.serverMembers.list.useQuery(
    { serverId },
    { refetchInterval: 20000 }
  );
  const myRoleQuery = trpc.serverMembers.myRole.useQuery({ serverId });

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

  const members = membersQuery.data ?? [];
  const myRole = (myRoleQuery.data ?? null) as Role | null;

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
      <div className="h-12 px-4 flex items-center border-b border-slate-800">
        <span className="text-sm font-semibold text-slate-300">
          Members
          <span className="ml-1.5 text-xs text-slate-500">{members.length}</span>
        </span>
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
