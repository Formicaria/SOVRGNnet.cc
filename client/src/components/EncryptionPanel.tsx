import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  CryptoSession,
  DeviceEntry,
  SasPrompt,
  VerificationRequest,
} from "@/lib/matrixCrypto";
import { looksLikeRecoveryKey, type ReadinessVerdict } from "@shared/e2ee";

/**
 * Everything a person has to do themselves for encryption to mean anything —
 * ADR 0008 stage 4.
 *
 * ADR 0008 was explicit that Matrix's defence against an instance minting a
 * device for you "only works if people act on the warning". This panel is
 * where the warning is shown and where acting on it is possible. If it is
 * unclear, or buried, or the device list is a wall of identical rows, then the
 * cryptography underneath is decoration — so the ordering here is deliberate:
 * the single most useful next action first, unverified devices above verified
 * ones, and the recovery key shown exactly once with a plain sentence about
 * what losing it costs.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: CryptoSession | null;
  /** Bumps when something inside the session changed; drives the refresh. */
  revision: number;
  /** A request from another device, surfaced by the session. */
  incoming: VerificationRequest | null;
  onIncomingHandled: () => void;
  /**
   * Opened by the app rather than by the user, because nothing is set up yet.
   *
   * Changes the framing and adds a way out. Every channel on this instance is
   * encrypted, so a person who never opens this panel is a person whose
   * history dies with their browser profile — which makes the prompt part of
   * the feature rather than a nag. It is still skippable: a modal that can't
   * be dismissed is a modal people learn to fear, and the badge keeps saying
   * so afterwards.
   */
  firstRun?: boolean;
}

type Busy = null | "setup" | "recover" | "verify";

export function EncryptionPanel({
  open,
  onOpenChange,
  session,
  revision,
  incoming,
  onIncomingHandled,
  firstRun = false,
}: Props) {
  const [verdict, setVerdict] = useState<ReadinessVerdict | null>(null);
  const [devices, setDevices] = useState<DeviceEntry[]>([]);
  // Whether the readiness check is in flight, and why it last failed. Both
  // exist because the panel used to have no way to say either — see `refresh`.
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [restored, setRestored] = useState<{
    imported: number;
    total: number;
  } | null>(null);
  const [sas, setSas] = useState<SasPrompt | null>(null);

  const refresh = useCallback(async () => {
    if (!session) {
      setVerdict(null);
      setDevices([]);
      return;
    }
    setChecking(true);
    try {
      const [readiness, list] = await Promise.all([
        session.readiness(),
        session.listDevices(),
      ]);
      setVerdict(readiness.verdict);
      setDevices(list);
      setCheckFailed(null);
    } catch (err) {
      // This used to be an empty catch, on the reasoning that a failed
      // readiness check tells the user nothing they can use, so the panel
      // should keep its last state instead of flashing an error.
      //
      // On the first open there is no last state. The panel kept nothing: a
      // heading, a sentence about keys living on your devices, "No devices
      // reported yet", and a Close button — no verdict, no setup button, no
      // recovery key field, and nothing at all to say a check had been run and
      // failed. Silently. Forever. The one screen standing between a person
      // and losing their entire history rendered as a shrug.
      //
      // Saying nothing is not the gentle option here. It is the same
      // overstatement this project keeps correcting, wearing the opposite
      // face: a panel that shows no warnings reads as a panel with no problems
      // to report. Found by the browser stage, which opened it and asked what
      // it said.
      setCheckFailed(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  }, [session]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, revision, refresh]);

  const drive = useCallback(
    async (request: VerificationRequest) => {
      if (!session) return;
      setBusy("verify");
      setError(null);
      try {
        setSas(await session.sasFor(request));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Verification failed.");
      } finally {
        setBusy(null);
      }
    },
    [session]
  );

  // An incoming request opens the panel on its own. A verification prompt that
  // waits behind a menu is a verification prompt that times out.
  useEffect(() => {
    if (!incoming) return;
    onOpenChange(true);
    void drive(incoming);
    onIncomingHandled();
  }, [incoming, drive, onOpenChange, onIncomingHandled]);

  const setUp = async () => {
    if (!session) return;
    setBusy("setup");
    setError(null);
    try {
      const result = await session.bootstrapEncryption();
      setRecoveryKey(result.recoveryKey);
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't set up encryption."
      );
    } finally {
      setBusy(null);
    }
  };

  const recover = async () => {
    if (!session) return;
    setBusy("recover");
    setError(null);
    try {
      setRestored(await session.recoverWithKey(keyInput));
      setKeyInput("");
      await refresh();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't use that recovery key."
      );
    } finally {
      setBusy(null);
    }
  };

  const verifyThisDevice = async () => {
    if (!session) return;
    setBusy("verify");
    setError(null);
    try {
      await drive(await session.requestOwnVerification());
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't start verification."
      );
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-800 text-slate-100 max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-purple-400" />
            Encryption
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Keys for encrypted channels live on your devices. This instance
            can't read them, and can't get them back for you.
          </DialogDescription>
        </DialogHeader>

        {!session ? (
          <p className="text-sm text-slate-400">
            This client isn't holding its own Matrix session, so there's nothing
            to set up here. Encrypted channels stay unreadable on this device.
          </p>
        ) : sas ? (
          <SasView
            sas={sas}
            onDone={async () => {
              setSas(null);
              await refresh();
            }}
          />
        ) : recoveryKey ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">
              This is your recovery key. It is shown once. Anyone who has it can
              read your encrypted messages; without it, losing every signed-in
              device loses every encrypted message you have.
            </p>
            <div className="rounded-md border border-purple-800 bg-slate-950 p-3 font-mono text-sm tracking-wide break-all">
              {recoveryKey}
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(recoveryKey);
                  setCopied(true);
                }}
              >
                {copied ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
                {copied ? "Copied" : "Copy"}
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setRecoveryKey(null);
                  setCopied(false);
                }}
              >
                I've saved it
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {firstRun && verdict?.level === "unset" && (
              <p className="text-sm text-slate-300">
                Every channel here is end-to-end encrypted, so your messages are
                readable only on your own devices — not by whoever runs this
                instance. That also means nobody can recover them for you.
                Setting up now gives you a recovery key and backs up your
                message keys, so a new device can read your history.
              </p>
            )}

            {/* No verdict means the check is still running or it failed, and
                those are different enough to say out loud. Every control below
                is gated on `verdict`, so without this the panel renders as an
                empty box either way — which is how a broken readiness check
                spent a release looking exactly like a clean bill of health. */}
            {!verdict && (
              <div className="rounded-md border border-amber-900 bg-amber-950/30 p-3">
                <p className="text-sm text-slate-100">
                  {checking
                    ? "Checking this device's encryption…"
                    : "Couldn't check this device's encryption."}
                </p>
                {!checking && (
                  <p className="mt-1 text-xs text-slate-400">
                    {checkFailed ?? "The crypto session didn't answer."} Nothing
                    here can be set up until that works, and until it does this
                    device has no recovery key and no verified status —
                    whatever it may have had before. Reloading is worth trying
                    first.
                  </p>
                )}
              </div>
            )}

            {verdict && (
              <div
                className={`rounded-md border p-3 ${
                  verdict.level === "ready"
                    ? "border-emerald-900 bg-emerald-950/40"
                    : "border-amber-900 bg-amber-950/30"
                }`}
              >
                <p className="text-sm text-slate-100">{verdict.headline}</p>
                {verdict.nextStep && (
                  <p className="mt-1 text-xs text-slate-400">
                    {verdict.nextStep}
                  </p>
                )}
              </div>
            )}

            {verdict?.level === "unset" && (
              <div className="flex gap-2">
                <Button
                  onClick={setUp}
                  disabled={busy !== null}
                  className="flex-1"
                >
                  {busy === "setup" && (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  )}
                  Set up encryption
                </Button>
                {firstRun && (
                  // Skippable on purpose. A dialog with no way out is one
                  // people click through without reading, which produces a
                  // recovery key nobody saved and a worse outcome than asking
                  // again later.
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    Not now
                  </Button>
                )}
              </div>
            )}

            {verdict && verdict.level !== "ready" && (
              <div className="space-y-2">
                {verdict.level === "incomplete" && (
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={verifyThisDevice}
                    disabled={busy !== null}
                  >
                    {busy === "verify" && (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    )}
                    Verify this device from another one
                  </Button>
                )}

                <div className="flex gap-2">
                  <Input
                    value={keyInput}
                    onChange={e => setKeyInput(e.target.value)}
                    placeholder="Or paste your recovery key"
                    className="bg-slate-800 border-slate-700 text-sm font-mono"
                  />
                  <Button
                    variant="secondary"
                    onClick={recover}
                    disabled={busy !== null || !looksLikeRecoveryKey(keyInput)}
                  >
                    {busy === "recover" ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      "Use key"
                    )}
                  </Button>
                </div>
              </div>
            )}

            {restored && (
              <p className="text-xs text-emerald-400">
                Restored {restored.imported} of {restored.total} keys from your
                backup.
              </p>
            )}

            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 mb-2">
                Your devices
              </p>
              <ScrollArea className="max-h-56">
                <div className="space-y-1 pr-2">
                  {devices.length === 0 && (
                    <p className="text-sm text-slate-500">
                      No devices reported yet.
                    </p>
                  )}
                  {devices.map(device => (
                    <div
                      key={device.deviceId}
                      className="flex items-center justify-between gap-2 rounded-md border border-slate-800 bg-slate-950/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-slate-200">
                          {device.displayName ?? device.deviceId}
                        </p>
                        <p className="truncate text-xs text-slate-500 font-mono">
                          {device.deviceId}
                          {device.isOwnDevice && " · this device"}
                        </p>
                      </div>
                      {device.verified ? (
                        <Badge className="shrink-0 border-emerald-800 bg-emerald-950 text-emerald-300">
                          <ShieldCheck className="w-3 h-3" /> Verified
                        </Badge>
                      ) : (
                        <Badge className="shrink-0 border-amber-800 bg-amber-950 text-amber-300">
                          <ShieldQuestion className="w-3 h-3" /> Unverified
                        </Badge>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
              {devices.some(d => !d.verified) && (
                <p className="mt-2 flex gap-1.5 text-xs text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>
                    An unverified device you don't recognise may have been
                    created by whoever runs this instance. It receives no keys
                    until it's verified — so leaving it alone is a safe answer.
                  </span>
                </p>
              )}
            </div>
          </div>
        )}

        {error && <p className="text-sm text-red-400">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The emoji comparison.
 *
 * "They don't match" is a distinct action from closing the dialog, and it
 * sends `m.mismatched_sas` rather than a plain cancel: the difference is
 * whether the other side learns that somebody saw different emoji, which is
 * the only signal that a machine-in-the-middle just failed.
 */
function SasView({ sas, onDone }: { sas: SasPrompt; onDone: () => void }) {
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-300">
        Check that these appear in the same order on both devices.
      </p>
      <div className="grid grid-cols-4 gap-2">
        {sas.emoji.map(([glyph, name], index) => (
          <div
            key={`${glyph}-${index}`}
            className="flex flex-col items-center gap-1 rounded-md border border-slate-800 bg-slate-950 py-3"
          >
            <span className="text-2xl leading-none">{glyph}</span>
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              {name}
            </span>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              await sas.confirm();
            } finally {
              onDone();
            }
          }}
        >
          {pending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Check className="w-4 h-4" />
          )}
          They match
        </Button>
        <Button
          variant="destructive"
          className="flex-1"
          disabled={pending}
          onClick={() => {
            sas.mismatch();
            onDone();
          }}
        >
          <X className="w-4 h-4" />
          They don't match
        </Button>
      </div>
    </div>
  );
}
