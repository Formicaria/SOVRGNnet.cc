import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Check, ShieldAlert } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/contexts/AuthContext";

function formatUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400)
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function HealthDot({ up }: { up: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${
        up ? "bg-emerald-400" : "bg-red-500"
      }`}
      aria-hidden="true"
    />
  );
}

type JoinPolicy = "open" | "invite" | "closed";

const POLICIES: Array<{ value: JoinPolicy; label: string; detail: string }> = [
  {
    value: "open",
    label: "Anyone can join",
    detail: "Anybody who finds the address can create an account.",
  },
  {
    value: "invite",
    label: "Invite only",
    detail: "A valid invite link is required to sign up.",
  },
  {
    value: "closed",
    label: "Closed",
    detail: "No new accounts at all. Existing members can still sign in.",
  },
];

/**
 * Instance settings, for whoever administers this server.
 *
 * The point of this dialog is that running a SOVRGNnet server shouldn't
 * require SSH. Everything here used to be an environment variable and a
 * restart.
 */
export default function ServerSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = trpc.useUtils();
  const { user: me } = useAuth();
  const [tab, setTab] = useState<"settings" | "health" | "members">("settings");
  const settingsQuery = trpc.admin.getSettings.useQuery(undefined, { enabled: open });

  // Health refreshes while it's being looked at; a status panel showing
  // ten-minute-old truth is worse than none.
  const overviewQuery = trpc.admin.overview.useQuery(undefined, {
    enabled: open && tab === "health",
    refetchInterval: 10_000,
  });
  const usersQuery = trpc.admin.listUsers.useQuery(undefined, {
    enabled: open && tab === "members",
  });
  const setRole = trpc.admin.setUserRole.useMutation({
    onSuccess: async () => {
      setError(null);
      await utils.admin.listUsers.invalidate();
    },
    onError: e => setError(e.message),
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [joinPolicy, setJoinPolicy] = useState<JoinPolicy>("invite");
  const [listed, setListed] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the server's answer into the form once, when the dialog opens.
  useEffect(() => {
    const data = settingsQuery.data;
    if (!data) return;
    setName(data.name);
    setDescription(data.description ?? "");
    setJoinPolicy(data.joinPolicy as JoinPolicy);
    setListed(data.listed);
  }, [settingsQuery.data]);

  const save = trpc.admin.updateSettings.useMutation({
    onSuccess: async () => {
      setSaved(true);
      setError(null);
      await utils.admin.getSettings.invalidate();
      setTimeout(() => setSaved(false), 2000);
    },
    onError: e => setError(e.message),
  });

  const data = settingsQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-100 max-w-lg">
        <DialogHeader>
          <DialogTitle>Server settings</DialogTitle>
          <DialogDescription>
            How this instance presents itself, and who's allowed in.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b border-slate-800 -mt-1">
          {(
            [
              ["settings", "Settings"],
              ["health", "Health"],
              ["members", "Members"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
                tab === key
                  ? "text-white border-b-2 border-purple-500"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "health" && (
          <div className="space-y-4 min-h-[200px]">
            {overviewQuery.isLoading && (
              <Loader2 className="w-5 h-5 animate-spin text-purple-500 mx-auto my-6" />
            )}
            {overviewQuery.data && (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {(
                    [
                      ["Database", overviewQuery.data.checks.database],
                      ["Homeserver", overviewQuery.data.checks.homeserver],
                      ["IPFS", overviewQuery.data.checks.ipfs],
                    ] as const
                  ).map(([label, up]) => (
                    <div
                      key={label}
                      className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 flex items-center gap-2"
                    >
                      <HealthDot up={up} />
                      <span className="text-sm">{label}</span>
                    </div>
                  ))}
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-1.5 text-sm">
                  <p className="text-slate-300">
                    v{overviewQuery.data.version} · up{" "}
                    {formatUptime(overviewQuery.data.uptimeSeconds)}
                  </p>
                  <p className="text-slate-400 text-xs">
                    Direct Matrix sync:{" "}
                    {overviewQuery.data.directSync.available ? (
                      <span className="text-emerald-400">available</span>
                    ) : (
                      <span title={overviewQuery.data.directSync.detail ?? undefined}>
                        proxied — {overviewQuery.data.directSync.detail}
                      </span>
                    )}
                  </p>
                  <p className="text-slate-400 text-xs">
                    Event ingest:{" "}
                    {overviewQuery.data.eventIngest ? (
                      <span className="text-emerald-400">configured</span>
                    ) : (
                      "not configured — clients send through the API"
                    )}
                  </p>
                  {overviewQuery.data.totals && (
                    <p className="text-slate-500 text-xs font-mono">
                      {overviewQuery.data.totals.users} accounts ·{" "}
                      {overviewQuery.data.totals.servers} communities ·{" "}
                      {overviewQuery.data.totals.messages} messages
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {tab === "members" && (
          <div className="space-y-2 min-h-[200px] max-h-80 overflow-y-auto">
            {usersQuery.isLoading && (
              <Loader2 className="w-5 h-5 animate-spin text-purple-500 mx-auto my-6" />
            )}
            {(usersQuery.data ?? []).map(account => (
              <div
                key={account.id}
                className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">
                    {account.name ?? account.email ?? `#${account.id}`}
                    {me && account.id === me.id && (
                      <span className="text-slate-500"> (you)</span>
                    )}
                  </p>
                  <p className="text-[11px] text-slate-500 truncate">
                    {account.email} · joined{" "}
                    {new Date(account.createdAt).toLocaleDateString()}
                  </p>
                </div>
                {account.role === "admin" ? (
                  <span className="text-[11px] uppercase tracking-wide text-purple-300">
                    admin
                  </span>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  className="border-slate-700 text-xs"
                  disabled={setRole.isPending || (me != null && account.id === me.id)}
                  onClick={() =>
                    setRole.mutate({
                      userId: account.id,
                      role: account.role === "admin" ? "user" : "admin",
                    })
                  }
                >
                  {account.role === "admin" ? "Remove admin" : "Make admin"}
                </Button>
              </div>
            ))}
            {error && (
              <p className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded px-3 py-2">
                {error}
              </p>
            )}
          </div>
        )}

        {tab === "settings" && settingsQuery.isLoading && (
          <Loader2 className="w-5 h-5 animate-spin text-purple-500 mx-auto my-6" />
        )}

        {tab === "settings" && data && (
          <div className="space-y-5">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Name</label>
              <Input
                value={name}
                onChange={e => setName(e.target.value)}
                className="bg-slate-800 border-slate-700"
                maxLength={120}
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-1.5">
                Description <span className="text-slate-600">(optional)</span>
              </label>
              <Input
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="What this server is for"
                className="bg-slate-800 border-slate-700"
                maxLength={500}
              />
            </div>

            <div>
              <label className="text-xs text-slate-400 block mb-2">Who can join</label>
              <div className="space-y-1.5">
                {POLICIES.map(policy => (
                  <button
                    key={policy.value}
                    onClick={() => setJoinPolicy(policy.value)}
                    className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                      joinPolicy === policy.value
                        ? "border-purple-600 bg-purple-950/40"
                        : "border-slate-700 bg-slate-800/60 hover:border-slate-600"
                    }`}
                  >
                    <span className="text-sm font-medium block">{policy.label}</span>
                    <span className="text-xs text-slate-400">{policy.detail}</span>
                  </button>
                ))}
              </div>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={listed}
                onChange={e => setListed(e.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="text-sm block">List in the public directory</span>
                <span className="text-xs text-slate-400">
                  Makes this server findable by name on sovrgnnet.cc. Joining
                  still follows the rule above. Off by default.
                </span>
              </span>
            </label>

            {/* Facts an admin needs, that this dialog deliberately can't
                change: the Matrix name is permanent, and encryption is a
                property of the build. */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-1.5">
              <p className="text-[11px] text-slate-500 font-mono">
                {data.matrixServerName} · v{data.version} · {data.instanceId}
              </p>
              {!data.encryption && (
                <p className="text-xs text-amber-400/90 flex items-start gap-1.5">
                  <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  Messages on this server are not end-to-end encrypted. You can
                  read them.
                </p>
              )}
            </div>

            {error && (
              <p className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded px-3 py-2">
                {error}
              </p>
            )}
          </div>
        )}

        {tab === "settings" && (
        <DialogFooter>
          <Button
            disabled={!data || save.isPending || !name.trim()}
            onClick={() =>
              save.mutate({
                name: name.trim(),
                description: description.trim() || null,
                joinPolicy,
                listed,
              })
            }
          >
            {save.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {saved && <Check className="w-4 h-4 mr-2" />}
            {saved ? "Saved" : "Save"}
          </Button>
        </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
