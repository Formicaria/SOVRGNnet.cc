import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { checkUsername } from "@shared/username";
import { useAuth } from "@/contexts/AuthContext";
import { trpc } from "@/lib/trpc";

/**
 * The account panel: your username, your Matrix address, and renaming.
 *
 * This is where two things that existed only as API surface become reachable —
 * `auth.changeUsername` (#33) and `auth.linkSso` (#32). An endpoint with no
 * entry point is a feature nobody has.
 *
 * ## Why the rename flow has two steps
 *
 * Because the consequences are not obvious and are not reversible. Matrix has
 * no rename: the account keeps the address it was registered with, forever, and
 * every message already sent stays attributed to it on servers this one does
 * not control. Someone renaming to get away from a previous name is owed that
 * fact *before* they commit, not in a toast afterwards.
 *
 * The consequences are fetched from the server rather than written here. They
 * are the server's account of its own behaviour (`renameConsequences`), so this
 * component cannot describe a rename the code doesn't perform — the failure
 * mode when warning copy lives in a component is that the code changes and the
 * copy doesn't. See ADR 0012.
 */
export function AccountSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Reopening should not resume a half-finished rename from last time.
  useEffect(() => {
    if (open) {
      setDraft("");
      setConfirming(false);
      setError(null);
      setDone(false);
    }
  }, [open]);

  const trimmed = draft.trim();
  const local = trimmed ? checkUsername(trimmed) : null;
  const localProblem = local && !local.ok ? local.message : null;
  const unchanged =
    Boolean(user?.username) && trimmed.toLowerCase() === user?.username;

  // Only asked once the name is locally valid — no point spending a round trip
  // to be told what checkUsername already knows, and it keeps the panel quiet
  // while someone is still typing.
  const preview = trpc.auth.renamePreview.useQuery(
    { username: local?.ok ? local.username : "" },
    { enabled: Boolean(local?.ok) && !unchanged, staleTime: 10_000 }
  );

  const rename = trpc.auth.changeUsername.useMutation({
    onSuccess: async result => {
      // Refetch rather than patch: a username change touches the member list,
      // mentions and anything else keyed on it, and guessing which caches
      // matter is how one of them ends up stale.
      await utils.invalidate();
      setDone(result.changed);
      setConfirming(false);
      setDraft("");
    },
    onError: e => {
      setError(e.message);
      setConfirming(false);
    },
  });

  const available =
    preview.data?.ok === true ? preview.data.available : undefined;
  const consequences =
    preview.data?.ok === true ? preview.data.consequences : [];

  const canContinue =
    Boolean(local?.ok) && !unchanged && available === true && !rename.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>
            How this server identifies you, and what that means elsewhere.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Username
            </p>
            <p className="font-mono">@{user?.username ?? "—"}</p>
          </div>

          {/*
            Email is shown as absent rather than omitted when there isn't one.
            An empty row invites "did it forget mine?"; naming the consequence
            is the same honesty the sign-up form uses.
          */}
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Email
            </p>
            {user?.email ? (
              <p>{user.email}</p>
            ) : (
              <p className="text-muted-foreground">
                None. There is no way to reset your password — losing it loses
                the account.
              </p>
            )}
          </div>

          <div className="border-t pt-4 space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Change username
            </p>

            {done && (
              <p className="flex items-start gap-2 text-emerald-500">
                <Check className="h-4 w-4 mt-0.5 shrink-0" />
                <span>
                  Done. People here see you as @{user?.username}. Your Matrix
                  address is unchanged.
                </span>
              </p>
            )}

            {confirming ? (
              <div className="space-y-3">
                <p className="font-medium">
                  Rename to @{local?.ok ? local.username : trimmed}?
                </p>

                {/* The disclosure. Server-supplied — see the file comment. */}
                <ul className="space-y-2">
                  {consequences.map(c => (
                    <li key={c.headline} className="space-y-0.5">
                      <p className="flex items-start gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 mt-1 shrink-0 text-amber-500" />
                        <span className="font-medium">{c.headline}</span>
                      </p>
                      <p className="pl-[1.375rem] text-xs text-muted-foreground">
                        {c.detail}
                      </p>
                    </li>
                  ))}
                </ul>

                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setConfirming(false)}
                    disabled={rename.isPending}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    disabled={!canContinue}
                    onClick={() => {
                      const checked = checkUsername(trimmed);
                      if (!checked.ok) {
                        setError(checked.message);
                        setConfirming(false);
                        return;
                      }
                      setError(null);
                      rename.mutate({
                        username: checked.username,
                        // Set here, at the one call site, immediately after the
                        // list above was rendered. That adjacency is the whole
                        // purpose of the field — see the endpoint's comment on
                        // why it is not a security control.
                        acknowledgedMatrixId: true,
                      });
                    }}
                  >
                    {rename.isPending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        Renaming…
                      </>
                    ) : (
                      "I understand, rename me"
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Input
                  placeholder="New username"
                  value={draft}
                  onChange={e => {
                    setDraft(e.target.value);
                    setError(null);
                    setDone(false);
                  }}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  onKeyDown={e => {
                    if (e.key === "Enter" && canContinue) setConfirming(true);
                  }}
                />

                {localProblem && (
                  <p className="text-xs text-amber-500">{localProblem}</p>
                )}
                {!localProblem && unchanged && (
                  <p className="text-xs text-muted-foreground">
                    That's the name you already have.
                  </p>
                )}
                {!localProblem && !unchanged && available === false && (
                  <p className="text-xs text-amber-500">
                    Someone already has that username on this server.
                  </p>
                )}

                <Button
                  variant="outline"
                  className="w-full"
                  disabled={!canContinue}
                  onClick={() => setConfirming(true)}
                >
                  Continue
                </Button>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
