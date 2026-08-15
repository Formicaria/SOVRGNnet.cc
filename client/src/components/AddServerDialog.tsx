import { useState } from "react";
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
import { Loader2, ShieldCheck, ShieldAlert, Server } from "lucide-react";
import {
  NotASovrgnServer,
  ServerTooNew,
  normalizeHost,
  probeInstance,
  type InstanceInfo,
} from "@shared/connections";
import { parseInvite, serverBaseUrl } from "@shared/invite";
import { useConnections } from "@/contexts/ConnectionsContext";

/**
 * Add a server by address or invite link.
 *
 * Deliberately two steps: **look**, then **join**. The client asks the server
 * what it is and shows the answer before anything is saved, so pointing at a
 * typo'd address produces "that isn't a SOVRGNnet server" rather than a
 * half-added entry or a password prompt on a stranger's website.
 */
export default function AddServerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { connect, multiplexes } = useConnections();

  const [input, setInput] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<{ info: InstanceInfo; base: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setInput("");
    setFound(null);
    setError(null);
    setChecking(false);
  };

  const look = async () => {
    const raw = input.trim();
    if (!raw || checking) return;

    setChecking(true);
    setError(null);
    setFound(null);

    try {
      // An invite names its own server, so it doubles as an address.
      const invite = parseInvite(raw);
      const base = invite ? serverBaseUrl(invite) : serverBaseUrl(normalizeHost(raw));
      setFound({ info: await probeInstance(base), base });
    } catch (err) {
      if (err instanceof ServerTooNew) {
        setError("That server is newer than this app. Update, then try again.");
      } else if (err instanceof NotASovrgnServer) {
        setError(
          "Couldn't find a SOVRGNnet server there. Check the address, and that the server is switched on."
        );
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong");
      }
    } finally {
      setChecking(false);
    }
  };

  const join = async () => {
    if (!found) return;
    try {
      await connect(found.base);
      onOpenChange(false);
      reset();
      // In a browser each server is its own origin and its own session, so
      // "switching" means actually going there.
      if (!multiplexes && typeof window !== "undefined") {
        window.location.href = found.base;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that server");
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-100">
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Paste an invite link, or the address of a server someone runs.
          </DialogDescription>
        </DialogHeader>

        <Input
          autoFocus
          value={input}
          onChange={e => {
            setInput(e.target.value);
            setFound(null);
            setError(null);
          }}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault();
              found ? void join() : void look();
            }
          }}
          placeholder="chat.example.com  ·  https://…/invite/abc123"
          className="bg-slate-800 border-slate-700 font-mono text-sm"
        />

        {error && (
          <p className="text-sm text-red-300 bg-red-950/50 border border-red-900 rounded px-3 py-2">
            {error}
          </p>
        )}

        {found && (
          <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-4 space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-xl bg-slate-700 flex items-center justify-center shrink-0">
                <Server className="w-5 h-5 text-purple-300" />
              </div>
              <div className="min-w-0">
                <p className="font-medium truncate">{found.info.name}</p>
                {found.info.description && (
                  <p className="text-xs text-slate-400">{found.info.description}</p>
                )}
                <p className="text-[11px] text-slate-500 font-mono truncate">
                  {found.info.matrixServerName} · v{found.info.software.version}
                </p>
              </div>
            </div>

            {/* Encryption status is stated plainly, every time. Someone about
                to type a password deserves to know which kind of server this
                is before they do. */}
            <div className="flex items-start gap-2 text-xs">
              {found.info.encryption ? (
                <>
                  <ShieldCheck className="w-4 h-4 text-green-400 shrink-0 mt-0.5" />
                  <span className="text-slate-300">
                    Messages here are end-to-end encrypted.
                  </span>
                </>
              ) : (
                <>
                  <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <span className="text-slate-400">
                    Not end-to-end encrypted — whoever runs this server can read
                    messages on it.
                  </span>
                </>
              )}
            </div>

            {found.info.joinPolicy === "closed" && (
              <p className="text-xs text-slate-400">
                This server isn't accepting new accounts. You can add it, but
                you'll need an existing account to sign in.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {found ? (
            <Button onClick={() => void join()}>Add server</Button>
          ) : (
            <Button disabled={!input.trim() || checking} onClick={() => void look()}>
              {checking && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Look it up
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
