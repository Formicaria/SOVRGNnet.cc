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
  const settingsQuery = trpc.admin.getSettings.useQuery(undefined, { enabled: open });

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

        {settingsQuery.isLoading && (
          <Loader2 className="w-5 h-5 animate-spin text-purple-500 mx-auto my-6" />
        )}

        {data && (
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
      </DialogContent>
    </Dialog>
  );
}
