import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
 *
 * ## Why sessions and profile live here too
 *
 * Same reason: `profile.devices`, `profile.signOutDevice` and `profile.update`
 * were all implemented and all unreachable. Sessions in particular belong here
 * rather than next to the device list in EncryptionPanel, which looks like the
 * obvious home and isn't:
 *
 *   - That list comes from the client's own crypto session and answers "which
 *     of my devices do I trust with keys". This one comes from the homeserver
 *     and answers "which sessions can act as me". They overlap without being
 *     the same question, and merging them would make a *verification* screen
 *     the place you accidentally end a session.
 *   - EncryptionPanel renders nothing at all without a local crypto session.
 *     Revoking a session you no longer hold is exactly when you can't be on the
 *     device that holds it, so gating revocation on that would remove it in the
 *     one case it matters. These procedures run server-side against the stored
 *     token and need no crypto session at all.
 */
type Tab = "account" | "profile" | "sessions";

const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["account", "Account"],
  ["profile", "Profile"],
  ["sessions", "Sessions"],
];

/** "Last seen …", or null when the homeserver reported neither half of it. */
function lastSeenLabel(at: number | null, ip: string | null): string | null {
  const parts: string[] = [];
  if (at != null) parts.push(new Date(at).toLocaleString());
  if (ip) parts.push(ip);
  return parts.length > 0 ? `Last seen ${parts.join(" · ")}` : null;
}

export function AccountSettings({
  open,
  onOpenChange,
  currentDeviceId = null,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The Matrix device this browser is signed in on, when it holds a session.
   *
   * Optional because the panel has to work without one — see the note above on
   * why revocation can't depend on a local crypto session. Passed when it is
   * known purely so the list can say which row is the seat you're sitting in,
   * before you sign it out from under yourself.
   */
  currentDeviceId?: string | null;
}) {
  const { user } = useAuth();
  const utils = trpc.useUtils();

  const [tab, setTab] = useState<Tab>("account");
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const [avatarDraft, setAvatarDraft] = useState("");
  const [bioDraft, setBioDraft] = useState("");
  const [profileSaved, setProfileSaved] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);

  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState<string | null>(null);

  // Reopening should not resume a half-finished rename from last time, or land
  // on whichever tab was last poked at.
  useEffect(() => {
    if (open) {
      setTab("account");
      setDraft("");
      setConfirming(false);
      setError(null);
      setDone(false);
      setProfileError(null);
      setDeviceError(null);
      setSigningOut(null);
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

  // Both are asked for only while their tab is showing. The devices query in
  // particular costs the server a round trip to the homeserver.
  const profileQuery = trpc.profile.editable.useQuery(undefined, {
    enabled: open && tab === "profile",
  });
  const devicesQuery = trpc.profile.devices.useQuery(undefined, {
    enabled: open && tab === "sessions",
  });

  // Filling the form from the server's answer, not from the first render after
  // opening — at that point the query hasn't answered and there is nothing to
  // fill it with. `open` is a dependency for the same reason the reset above
  // exists: reopening should show what is stored, not an abandoned draft from
  // last time. It can do that immediately because the cached answer is still
  // there whether or not the query is enabled.
  useEffect(() => {
    const stored = profileQuery.data;
    if (!stored) return;
    setAvatarDraft(stored.avatar ?? "");
    setBioDraft(stored.bio ?? "");
  }, [open, profileQuery.data]);

  const saveProfile = trpc.profile.update.useMutation({
    onSuccess: async () => {
      setProfileError(null);
      setProfileSaved(true);
      await utils.profile.editable.invalidate();
      setTimeout(() => setProfileSaved(false), 2000);
    },
    onError: e => setProfileError(e.message),
  });

  const signOutDevice = trpc.profile.signOutDevice.useMutation({
    onSuccess: async () => {
      setSigningOut(null);
      setDeviceError(null);
      await utils.profile.devices.invalidate();
    },
    onError: e => {
      setSigningOut(null);
      setDeviceError(e.message);
    },
  });

  const available =
    preview.data?.ok === true ? preview.data.available : undefined;
  const consequences =
    preview.data?.ok === true ? preview.data.consequences : [];

  const canContinue =
    Boolean(local?.ok) && !unchanged && available === true && !rename.isPending;

  const devices = devicesQuery.data ?? [];
  const stored = profileQuery.data;
  const profileDirty =
    stored != null &&
    (avatarDraft.trim() !== (stored.avatar ?? "") ||
      bioDraft.trim() !== (stored.bio ?? ""));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Account</DialogTitle>
          <DialogDescription>
            How this server identifies you, and what that means elsewhere.
          </DialogDescription>
        </DialogHeader>

        <div className="flex gap-1 border-b -mt-1">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
                tab === key
                  ? "text-foreground border-b-2 border-primary"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "account" && (
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
        )}

        {tab === "profile" && (
          <div className="space-y-4 text-sm">
            <div className="space-y-1.5">
              <label
                htmlFor="account-avatar"
                className="text-xs uppercase tracking-wide text-muted-foreground block"
              >
                Avatar
              </label>
              {/*
                An address, not a file. There is no avatar upload on this
                instance — /api/upload writes into a channel's file index and
                would announce your new picture as a shared file in whatever
                channel it was pointed at. A URL or an IPFS hash is what the
                column has always held, and saying so beats a picker that
                silently posts.
              */}
              <Input
                id="account-avatar"
                value={avatarDraft}
                onChange={e => {
                  setAvatarDraft(e.target.value);
                  setProfileError(null);
                }}
                placeholder="https://… or an IPFS hash"
                spellCheck={false}
              />
              {avatarDraft.trim() && (
                <div className="flex items-center gap-2 pt-1">
                  <img
                    src={avatarDraft.trim()}
                    alt=""
                    className="h-10 w-10 rounded-full border object-cover bg-muted"
                    // A broken address is the common case while typing one, and
                    // the browser's own broken-image glyph says nothing useful.
                    onError={e => {
                      e.currentTarget.style.visibility = "hidden";
                    }}
                    onLoad={e => {
                      e.currentTarget.style.visibility = "visible";
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    Preview. Nothing is saved until you press Save.
                  </span>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="account-bio"
                className="text-xs uppercase tracking-wide text-muted-foreground block"
              >
                Bio
              </label>
              <Textarea
                id="account-bio"
                value={bioDraft}
                onChange={e => {
                  setBioDraft(e.target.value);
                  setProfileError(null);
                }}
                placeholder="Anything you want people here to know."
                rows={4}
              />
            </div>

            {/*
              Only the two fields this form owns are sent. `profile.update`
              leaves out of the UPDATE any field it wasn't given, so a save from
              here cannot blank the wallet address or — much worse — the Matrix
              id every room membership is keyed on.
            */}
            <div className="flex items-center gap-2">
              <Button
                disabled={!profileDirty || saveProfile.isPending}
                onClick={() =>
                  saveProfile.mutate({
                    avatar: avatarDraft.trim(),
                    bio: bioDraft.trim(),
                  })
                }
              >
                {saveProfile.isPending && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                {profileSaved && <Check className="h-4 w-4 mr-2" />}
                {profileSaved ? "Saved" : "Save"}
              </Button>
              {profileQuery.isLoading && (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Your avatar and bio are stored on this instance and shown to
              people here. They are not published to Matrix, so they don't
              follow you to other servers.
            </p>

            {profileError && (
              <p className="text-xs text-destructive">{profileError}</p>
            )}
          </div>
        )}

        {tab === "sessions" && (
          <div className="space-y-3 text-sm">
            <p className="text-xs text-muted-foreground">
              Every session signed in to your Matrix account. Signing one out
              ends it immediately — that device stops receiving messages and
              stops being able to decrypt new ones.
            </p>

            {devicesQuery.isLoading && (
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mx-auto my-6" />
            )}

            {!devicesQuery.isLoading && devices.length === 0 && (
              // The procedure answers an unreachable homeserver with an empty
              // list rather than an error, so this genuinely cannot tell the
              // two apart. Say both rather than picking the flattering one.
              <p className="text-xs text-muted-foreground">
                No sessions to show — either this account has never held a
                Matrix session, or the homeserver didn't answer.
              </p>
            )}

            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {devices.map(device => {
                const isThisDevice =
                  currentDeviceId != null &&
                  device.deviceId === currentDeviceId;
                const seen = lastSeenLabel(
                  device.lastSeenAt,
                  device.lastSeenIp
                );
                return (
                  <div
                    key={device.deviceId}
                    className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="truncate">
                        {device.displayName ?? device.deviceId}
                        {isThisDevice && (
                          <span className="text-muted-foreground">
                            {" "}
                            · this device
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground font-mono">
                        {device.deviceId}
                      </p>
                      {seen && (
                        <p className="truncate text-xs text-muted-foreground">
                          {seen}
                        </p>
                      )}
                    </div>

                    {device.isServer ? (
                      // Shown rather than hidden, and named for what it is. The
                      // instance holds a session on your account to do the work
                      // you asked it to; pretending otherwise by omitting the
                      // row would be the dishonest option, and the endpoint
                      // refuses to remove it anyway.
                      <span className="shrink-0 text-xs text-muted-foreground">
                        This server
                      </span>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        disabled={signingOut !== null}
                        onClick={() => {
                          if (
                            isThisDevice &&
                            !window.confirm(
                              "Sign out this device?\n\n" +
                                "This is the session you're using. You'll be signed out of " +
                                "encrypted channels here, and any message keys held only by " +
                                "this device go with it unless you have a recovery key."
                            )
                          ) {
                            return;
                          }
                          setSigningOut(device.deviceId);
                          signOutDevice.mutate({ deviceId: device.deviceId });
                        }}
                      >
                        {signingOut === device.deviceId ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <LogOut className="h-3.5 w-3.5" />
                        )}
                        Sign out
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            {deviceError && (
              <p className="text-xs text-destructive">{deviceError}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
