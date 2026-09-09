import { useEffect, useState, type ReactNode } from "react";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
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
import {
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { IDENTITY_ORIGIN } from "@shared/identityOrigin";
import { trpc } from "@/lib/trpc";
import type { AppRouter } from "../../../server/routers";
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

type Settings = inferRouterOutputs<AppRouter>["admin"]["getSettings"];
type SettingsPatch = inferRouterInputs<AppRouter>["admin"]["updateSettings"];

/** Which of the two answers `admin.getSettings` gave for a field's origin. */
type Source = Settings["federationEnabledSource"];

/** Settings held as free text, minus the one that is a number. */
const STRING_KEYS = [
  "matrixPublicUrl",
  "identityIssuer",
  "voiceUrl",
  "voiceApiKey",
  "ipfsApiUrl",
] as const;
type StringKey = (typeof STRING_KEYS)[number];

const FLAG_KEYS = ["federationEnabled", "ssoEnabled"] as const;
type FlagKey = (typeof FLAG_KEYS)[number];

/** Write-only: the API reports whether one is set and never what it is. */
const SECRET_KEYS = ["voiceApiSecret", "metricsToken"] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

type TextKey = StringKey | "readyTimeoutMs";
type HandBackKey = StringKey | FlagKey | SecretKey;

/**
 * The form, as three kinds of edit rather than one.
 *
 * `admin.updateSettings` distinguishes an omitted field ("leave it alone")
 * from an explicit null ("clear this, ask the environment again"), and a form
 * that only tracked values could express neither — it would send all ten
 * fields on every save and quietly make this instance the owner of every
 * setting the operator merely looked at. So the draft records *intent*:
 * `toEnvironment` is the null, everything else is compared against what the
 * server last said and omitted when it matches.
 */
type Draft = {
  text: Record<TextKey, string>;
  flag: Record<FlagKey, boolean>;
  /** A replacement secret typed this session. Empty means "not changing it". */
  secret: Record<SecretKey, string>;
  /** Fields to hand back to the environment — sent as null. */
  toEnvironment: Partial<Record<HandBackKey, true>>;
  /** Secrets to store as empty: off here, whatever the environment holds. */
  secretOff: Partial<Record<SecretKey, true>>;
};

function draftFrom(data: Settings): Draft {
  return {
    text: {
      matrixPublicUrl: data.matrixPublicUrl ?? "",
      identityIssuer: data.identityIssuer ?? "",
      voiceUrl: data.voiceUrl ?? "",
      voiceApiKey: data.voiceApiKey ?? "",
      ipfsApiUrl: data.ipfsApiUrl,
      readyTimeoutMs: String(data.readyTimeoutMs),
    },
    flag: {
      federationEnabled: data.federationEnabled,
      ssoEnabled: data.ssoEnabled,
    },
    secret: { voiceApiSecret: "", metricsToken: "" },
    toEnvironment: {},
    secretOff: {},
  };
}

function withFlag<K extends string>(
  map: Partial<Record<K, true>>,
  key: K,
  on: boolean
): Partial<Record<K, true>> {
  const next = { ...map };
  if (on) next[key] = true;
  else delete next[key];
  return next;
}

/**
 * The check `urlSetting` performs in server/routers.ts, run before the request
 * instead of after it.
 *
 * Duplicated deliberately, and kept word-for-word: the server is still the
 * authority, but a typo in a homeserver address shouldn't cost a round trip
 * and arrive back as a red toast detached from the field that caused it.
 */
function urlProblem(value: string, schemes: string[]): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    if (schemes.includes(new URL(trimmed).protocol)) return null;
  } catch {
    // Unparseable and wrong-scheme are the same mistake to whoever typed it,
    // so both fall through to the same sentence.
  }
  return `Enter a ${schemes.map(s => `${s}//`).join(" or ")} address, or leave it empty.`;
}

const HTTP_SCHEMES = ["http:", "https:"];
const WS_SCHEMES = ["ws:", "wss:"];

type Problems = Partial<Record<"name" | TextKey, string>>;

function problemsIn(name: string, draft: Draft): Problems {
  const problems: Problems = {};

  if (!name.trim()) problems.name = "A server needs a name.";

  for (const key of [
    "matrixPublicUrl",
    "identityIssuer",
    "ipfsApiUrl",
  ] as const) {
    const problem = urlProblem(draft.text[key], HTTP_SCHEMES);
    if (problem) problems[key] = problem;
  }
  const voice = urlProblem(draft.text.voiceUrl, WS_SCHEMES);
  if (voice) problems.voiceUrl = voice;

  const timeout = draft.text.readyTimeoutMs.trim();
  if (timeout !== "") {
    const ms = Number(timeout);
    if (!Number.isInteger(ms) || ms < 100 || ms > 60_000) {
      problems.readyTimeoutMs =
        "A whole number of milliseconds, from 100 to 60000.";
    }
  }

  return problems;
}

/**
 * What actually changed, in the shape `admin.updateSettings` reads.
 *
 * Every branch here is "is this different from what the server told us", which
 * is what keeps an untouched field out of the payload — and an untouched field
 * staying out of the payload is what keeps a `.env`-supplied value supplied by
 * the `.env` rather than copied into the row the first time somebody opened
 * this dialog to change the join policy.
 */
function patchFrom(
  data: Settings,
  draft: Draft,
  name: string,
  description: string,
  joinPolicy: JoinPolicy,
  listed: boolean
): SettingsPatch {
  const patch: SettingsPatch = {};
  const baseline = draftFrom(data);

  if (name.trim() !== data.name) patch.name = name.trim();
  const nextDescription = description.trim() || null;
  if (nextDescription !== data.description) patch.description = nextDescription;
  if (joinPolicy !== data.joinPolicy) patch.joinPolicy = joinPolicy;
  if (listed !== data.listed) patch.listed = listed;

  for (const key of STRING_KEYS) {
    if (draft.toEnvironment[key]) patch[key] = null;
    else if (draft.text[key].trim() !== baseline.text[key])
      patch[key] = draft.text[key].trim();
  }

  for (const key of FLAG_KEYS) {
    if (draft.toEnvironment[key]) patch[key] = null;
    else if (draft.flag[key] !== baseline.flag[key])
      patch[key] = draft.flag[key];
  }

  for (const key of SECRET_KEYS) {
    if (draft.toEnvironment[key]) patch[key] = null;
    else if (draft.secretOff[key]) patch[key] = "";
    else if (draft.secret[key] !== "") patch[key] = draft.secret[key];
  }

  // The timeout has no "explicitly empty" the way a URL does — a blank box
  // can only mean "no opinion", so it is the field's own way of saying
  // "environment", and it needs no separate gesture.
  const timeout = draft.text.readyTimeoutMs.trim();
  if (timeout !== baseline.text.readyTimeoutMs) {
    patch.readyTimeoutMs = timeout === "" ? null : Number(timeout);
  }

  return patch;
}

/**
 * A collapsed group of settings.
 *
 * Ten more fields arrived in v0.8 and all of them are things an operator sets
 * once, if ever; the two anyone opens this dialog for are still the name and
 * the join policy. Collapsed-by-default keeps those two where they were rather
 * than at the top of a scroll.
 *
 * `forceOpen` wins over the toggle so a section can't hide a field that is
 * failing validation — the alternative is a Save button that is disabled for a
 * reason folded out of sight.
 */
function Section({
  title,
  summary,
  defaultOpen = false,
  forceOpen = false,
  children,
}: {
  title: string;
  summary: string;
  defaultOpen?: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = open || forceOpen;

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-slate-500" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 text-slate-500" />
        )}
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto text-[11px] text-slate-500 truncate max-w-[45%]">
          {summary}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-3 space-y-4 border-t border-slate-800/70">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * A field's label, and where its current value comes from.
 *
 * The badge is not decoration. "Federation: off" means two different things
 * depending on whether this instance decided it or a `.env` file did, and only
 * one of those survives somebody else's next deploy — so the operator is told
 * which one they are looking at before they touch it, and given the one
 * gesture that moves a value back the other way.
 */
function SettingHeader({
  label,
  source,
  pending,
  onUseEnvironment,
  onKeep,
}: {
  label: string;
  source: Source;
  /** True once the operator has asked for this to go back to the environment. */
  pending?: boolean;
  /** Omitted for fields that hand themselves back by being emptied. */
  onUseEnvironment?: () => void;
  onKeep?: () => void;
}) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5">
      <label className="text-xs text-slate-400">{label}</label>
      <span className="ml-auto text-[11px] shrink-0">
        {pending ? (
          <span className="text-amber-300">
            back to the environment on save ·{" "}
            <button
              type="button"
              className="underline hover:text-amber-200"
              onClick={onKeep}
            >
              undo
            </button>
          </span>
        ) : source === "environment" ? (
          <span
            className="text-amber-400/80"
            title="This value comes from the process environment. Saving a different one makes this instance own it, and the environment stops being consulted."
          >
            from the environment
          </span>
        ) : (
          <span className="text-slate-500">
            set here
            {onUseEnvironment && (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline hover:text-slate-300"
                  onClick={onUseEnvironment}
                >
                  use the environment's
                </button>
              </>
            )}
          </span>
        )}
      </span>
    </div>
  );
}

function TextSetting({
  label,
  hint,
  placeholder,
  value,
  source,
  pending,
  problem,
  maxLength,
  onChange,
  onUseEnvironment,
  onKeep,
}: {
  label: string;
  hint: string;
  placeholder?: string;
  value: string;
  source: Source;
  pending?: boolean;
  problem?: string;
  maxLength: number;
  onChange: (value: string) => void;
  onUseEnvironment?: () => void;
  onKeep?: () => void;
}) {
  return (
    <div>
      <SettingHeader
        label={label}
        source={source}
        pending={pending}
        onUseEnvironment={onUseEnvironment}
        onKeep={onKeep}
      />
      <Input
        value={pending ? "" : value}
        onChange={e => onChange(e.target.value)}
        placeholder={pending ? "Whatever the environment says" : placeholder}
        disabled={pending}
        className="bg-slate-800 border-slate-700 font-mono text-xs disabled:opacity-50"
        maxLength={maxLength}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="text-xs text-slate-400 mt-1.5">{hint}</p>
      {problem && <p className="text-xs text-amber-500 mt-1">{problem}</p>}
    </div>
  );
}

function FlagSetting({
  label,
  hint,
  checked,
  source,
  pending,
  onChange,
  onUseEnvironment,
  onKeep,
}: {
  label: string;
  hint: string;
  checked: boolean;
  source: Source;
  pending?: boolean;
  onChange: (checked: boolean) => void;
  onUseEnvironment: () => void;
  onKeep: () => void;
}) {
  return (
    <div>
      <SettingHeader
        label={label}
        source={source}
        pending={pending}
        onUseEnvironment={onUseEnvironment}
        onKeep={onKeep}
      />
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          checked={checked}
          disabled={pending}
          onChange={e => onChange(e.target.checked)}
          className="mt-1"
        />
        <span className="text-xs text-slate-400">{hint}</span>
      </label>
    </div>
  );
}

/**
 * A secret: set it, clear it, never see it.
 *
 * There is no "current value" to render because the API refuses to send one —
 * a form that redisplays a secret has to receive it first, and then every
 * layer in between holds a copy it had no reason to hold. What is left is one
 * bit and three gestures, and the two clearing gestures are genuinely
 * different: *remove* stores an empty value here, which overrules the
 * environment, while *use the environment's* forgets what is stored and lets
 * `.env` answer again.
 */
function SecretSetting({
  label,
  hint,
  isSet,
  source,
  value,
  off,
  pending,
  onChange,
  onRemove,
  onUseEnvironment,
  onKeep,
}: {
  label: string;
  hint: string;
  isSet: boolean;
  source: Source;
  value: string;
  /** True once the operator has asked to store this as empty. */
  off?: boolean;
  pending?: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
  onUseEnvironment: () => void;
  onKeep: () => void;
}) {
  return (
    <div>
      <SettingHeader
        label={label}
        source={source}
        pending={pending}
        onUseEnvironment={onUseEnvironment}
        onKeep={onKeep}
      />
      <Input
        type="password"
        value={off || pending ? "" : value}
        onChange={e => onChange(e.target.value)}
        placeholder={
          isSet ? "Enter a new value to replace it" : "Enter a value"
        }
        disabled={off || pending}
        className="bg-slate-800 border-slate-700 font-mono text-xs disabled:opacity-50"
        maxLength={500}
        autoComplete="new-password"
        spellCheck={false}
      />
      <p className="text-xs text-slate-400 mt-1.5">{hint}</p>
      <p className="text-[11px] mt-1.5">
        {off ? (
          <span className="text-amber-300">
            removed on save ·{" "}
            <button
              type="button"
              className="underline hover:text-amber-200"
              onClick={onKeep}
            >
              undo
            </button>
          </span>
        ) : (
          <>
            <span className={isSet ? "text-emerald-400" : "text-slate-500"}>
              {isSet ? "Set" : "Not set"}
            </span>
            {isSet && !pending && (
              <>
                <span className="text-slate-600"> · </span>
                <button
                  type="button"
                  className="text-slate-500 underline hover:text-slate-300"
                  onClick={onRemove}
                >
                  remove
                </button>
              </>
            )}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Instance settings, for whoever administers this server.
 *
 * The point of this dialog is that running a SOVRGNnet server shouldn't
 * require SSH. Everything here used to be an environment variable and a
 * restart.
 *
 * As of v0.8 that is true of ten more of them — the voice credentials, the
 * homeserver address clients dial, the IPFS daemon, SSO, federation, the
 * metrics token, the readiness bound. Each carries a source, because a value
 * that came from a `.env` behaves differently from the same value stored here:
 * the stored one is this instance's, the environment one belongs to whoever
 * next writes the compose file. Saving a field takes ownership of it; handing
 * it back is a deliberate, separate gesture.
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
  const settingsQuery = trpc.admin.getSettings.useQuery(undefined, {
    enabled: open,
  });

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
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the server's answer into the form when the dialog opens, and again
  // whenever the server's answer changes.
  //
  // Reopening re-reads rather than resuming, because the draft now holds
  // intentions as well as values — "remove this secret", "hand this back to
  // the environment" — and one of those surviving a close and a reopen is a
  // change nobody asked for twice.
  useEffect(() => {
    const data = settingsQuery.data;
    if (!open || !data) return;
    setName(data.name);
    setDescription(data.description ?? "");
    setJoinPolicy(data.joinPolicy as JoinPolicy);
    setListed(data.listed);
    setDraft(draftFrom(data));
  }, [open, settingsQuery.data]);

  const save = trpc.admin.updateSettings.useMutation({
    onSuccess: async () => {
      setSaved(true);
      setError(null);
      // The typed secret and the pending clears are dropped here rather than
      // left to the refetch, because react-query's structural sharing hands
      // back the *same* object when the response is deeply equal — replacing
      // a secret with another one changes nothing `getSettings` reports, so
      // the effect above would never run and the box would still be armed to
      // send it again.
      setDraft(current =>
        current
          ? {
              ...current,
              secret: { voiceApiSecret: "", metricsToken: "" },
              toEnvironment: {},
              secretOff: {},
            }
          : current
      );
      await utils.admin.getSettings.invalidate();
      setTimeout(() => setSaved(false), 2000);
    },
    onError: e => setError(e.message),
  });

  const data = settingsQuery.data;

  const setText = (key: TextKey, value: string) =>
    setDraft(current => {
      if (!current) return current;
      const text: Record<TextKey, string> = { ...current.text };
      text[key] = value;
      return { ...current, text };
    });

  const setStringSetting = (key: StringKey, value: string) => {
    setText(key, value);
    // Typing is an answer, so it cancels a pending hand-back rather than
    // silently losing to it at save time.
    handBack(key, false);
  };

  const setFlagSetting = (key: FlagKey, value: boolean) =>
    setDraft(current => {
      if (!current) return current;
      const flag: Record<FlagKey, boolean> = { ...current.flag };
      flag[key] = value;
      return {
        ...current,
        flag,
        toEnvironment: withFlag(current.toEnvironment, key, false),
      };
    });

  const setSecret = (key: SecretKey, value: string) =>
    setDraft(current => {
      if (!current) return current;
      const secret: Record<SecretKey, string> = { ...current.secret };
      secret[key] = value;
      return {
        ...current,
        secret,
        secretOff: withFlag(current.secretOff, key, false),
        toEnvironment: withFlag(current.toEnvironment, key, false),
      };
    });

  const removeSecret = (key: SecretKey, on: boolean) =>
    setDraft(current => {
      if (!current) return current;
      const secret: Record<SecretKey, string> = { ...current.secret };
      if (on) secret[key] = "";
      return {
        ...current,
        secret,
        secretOff: withFlag(current.secretOff, key, on),
        toEnvironment: withFlag(current.toEnvironment, key, false),
      };
    });

  function handBack(key: HandBackKey, on: boolean) {
    setDraft(current =>
      current
        ? {
            ...current,
            toEnvironment: withFlag(current.toEnvironment, key, on),
            secretOff:
              key === "voiceApiSecret" || key === "metricsToken"
                ? withFlag(current.secretOff, key, false)
                : current.secretOff,
          }
        : current
    );
  }

  const problems: Problems = draft ? problemsIn(name, draft) : {};
  const patch: SettingsPatch =
    data && draft
      ? patchFrom(data, draft, name, description, joinPolicy, listed)
      : {};
  // Disabled on an empty patch rather than sent, because an empty save is not
  // a no-op on an instance nobody has configured yet: it creates the settings
  // row, and `joinPolicy` and `listed` are NOT NULL with defaults, so the row
  // would answer "invite, unlisted" over an INSTANCE_JOIN_POLICY=open .env
  // that nobody touched.
  const changed = Object.keys(patch).length > 0;
  const blocked = Object.keys(problems).length > 0;

  const policyLabel =
    POLICIES.find(p => p.value === joinPolicy)?.label ?? joinPolicy;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-100 max-w-lg">
        <DialogHeader>
          <DialogTitle>Server settings</DialogTitle>
          <DialogDescription>
            How this instance presents itself, who's allowed in, and what it's
            wired to.
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
                      <span
                        title={
                          overviewQuery.data.directSync.detail ?? undefined
                        }
                      >
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
                  disabled={
                    setRole.isPending || (me != null && account.id === me.id)
                  }
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

        {tab === "settings" && data && draft && (
          <div className="space-y-3">
            <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-1">
              <Section
                title="Identity"
                summary={name || "unnamed"}
                defaultOpen
                forceOpen={Boolean(problems.name)}
              >
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">
                    Name
                  </label>
                  <Input
                    value={name}
                    onChange={e => setName(e.target.value)}
                    className="bg-slate-800 border-slate-700"
                    maxLength={120}
                  />
                  {problems.name && (
                    <p className="text-xs text-amber-500 mt-1">
                      {problems.name}
                    </p>
                  )}
                </div>

                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">
                    Description{" "}
                    <span className="text-slate-600">(optional)</span>
                  </label>
                  <Input
                    value={description}
                    onChange={e => setDescription(e.target.value)}
                    placeholder="What this server is for"
                    className="bg-slate-800 border-slate-700"
                    maxLength={500}
                  />
                </div>
              </Section>

              <Section
                title="Access"
                summary={listed ? `${policyLabel} · listed` : policyLabel}
                defaultOpen
              >
                <div>
                  <label className="text-xs text-slate-400 block mb-2">
                    Who can join
                  </label>
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
                        <span className="text-sm font-medium block">
                          {policy.label}
                        </span>
                        <span className="text-xs text-slate-400">
                          {policy.detail}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* The directory this consents to does not exist yet (ROADMAP,
                    0.7 — unchecked). The flag shipped ahead of it so consent is a
                    standing setting an operator makes once, not a launch-day
                    email campaign — but the copy must not promise findability
                    nothing provides. When the directory ships, this text changes
                    in the same commit that makes it true. */}
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={listed}
                    onChange={e => setListed(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    <span className="text-sm block">
                      List in the public directory
                    </span>
                    <span className="text-xs text-slate-400">
                      Consents to this server appearing in the sovrgnnet.cc
                      directory when it launches — the directory doesn't exist
                      yet, so nothing is listed anywhere today. Joining will
                      still follow the rule above. Off by default.
                    </span>
                  </span>
                </label>
              </Section>

              <Section
                title="Federation"
                summary={draft.flag.federationEnabled ? "on" : "off"}
              >
                <FlagSetting
                  label="Federate with other Matrix servers"
                  hint="People here can talk to people on other homeservers, and copies of what they send live on machines you don't run. Dendrite reads this when it starts, so the switch takes hold on the homeserver's next restart, not on save."
                  checked={draft.flag.federationEnabled}
                  source={data.federationEnabledSource}
                  pending={draft.toEnvironment.federationEnabled}
                  onChange={value => setFlagSetting("federationEnabled", value)}
                  onUseEnvironment={() => handBack("federationEnabled", true)}
                  onKeep={() => handBack("federationEnabled", false)}
                />
              </Section>

              <Section
                title="Matrix"
                summary={draft.text.matrixPublicUrl || "not advertised"}
                forceOpen={Boolean(problems.matrixPublicUrl)}
              >
                <TextSetting
                  label="Public homeserver address"
                  hint="Where clients sync directly instead of proxying every event through this API. Leave it empty on a deployment where the homeserver is loopback-only — the instance then advertises no direct sync rather than one that doesn't answer."
                  placeholder="https://matrix.example.org"
                  value={draft.text.matrixPublicUrl}
                  source={data.matrixPublicUrlSource}
                  pending={draft.toEnvironment.matrixPublicUrl}
                  problem={problems.matrixPublicUrl}
                  maxLength={500}
                  onChange={value => setStringSetting("matrixPublicUrl", value)}
                  onUseEnvironment={() => handBack("matrixPublicUrl", true)}
                  onKeep={() => handBack("matrixPublicUrl", false)}
                />
              </Section>

              <Section
                title="Voice"
                summary={data.voiceConfigured ? "configured" : "not configured"}
                forceOpen={Boolean(problems.voiceUrl)}
              >
                {/* All three or nothing: voice.ts mints an admission token from
                    the key and the secret and points the client at the URL, so
                    two out of three is an instance that advertises voice and
                    then fails at the join. */}
                <p className="text-xs text-slate-400">
                  {data.voiceConfigured
                    ? "Voice channels are offered on this instance."
                    : "Voice channels are hidden until the address, the key and the secret are all present."}
                </p>

                <TextSetting
                  label="SFU address"
                  hint="The LiveKit server clients dial. Media flows client ↔ that server; nothing routes through here."
                  placeholder="wss://livekit.example.org"
                  value={draft.text.voiceUrl}
                  source={data.voiceUrlSource}
                  pending={draft.toEnvironment.voiceUrl}
                  problem={problems.voiceUrl}
                  maxLength={500}
                  onChange={value => setStringSetting("voiceUrl", value)}
                  onUseEnvironment={() => handBack("voiceUrl", true)}
                  onKeep={() => handBack("voiceUrl", false)}
                />

                <TextSetting
                  label="API key"
                  hint="Rides in every admission token as the issuer. Not a secret — the SFU treats it as a name."
                  value={draft.text.voiceApiKey}
                  source={data.voiceApiKeySource}
                  pending={draft.toEnvironment.voiceApiKey}
                  maxLength={200}
                  onChange={value => setStringSetting("voiceApiKey", value)}
                  onUseEnvironment={() => handBack("voiceApiKey", true)}
                  onKeep={() => handBack("voiceApiKey", false)}
                />

                <SecretSetting
                  label="API secret"
                  hint="Signs the admission tokens. Anyone holding it can mint entry to any room on your SFU."
                  isSet={data.hasVoiceApiSecret}
                  source={data.voiceApiSecretSource}
                  value={draft.secret.voiceApiSecret}
                  off={draft.secretOff.voiceApiSecret}
                  pending={draft.toEnvironment.voiceApiSecret}
                  onChange={value => setSecret("voiceApiSecret", value)}
                  onRemove={() => removeSecret("voiceApiSecret", true)}
                  onUseEnvironment={() => handBack("voiceApiSecret", true)}
                  onKeep={() => removeSecret("voiceApiSecret", false)}
                />
              </Section>

              <Section
                title="Storage"
                summary={draft.text.ipfsApiUrl}
                forceOpen={Boolean(problems.ipfsApiUrl)}
              >
                <TextSetting
                  label="IPFS API address"
                  hint="The Kubo daemon that stores attachments. Point it somewhere unreachable and uploads fail — there is no fallback store."
                  placeholder="http://localhost:5001"
                  value={draft.text.ipfsApiUrl}
                  source={data.ipfsApiUrlSource}
                  pending={draft.toEnvironment.ipfsApiUrl}
                  problem={problems.ipfsApiUrl}
                  maxLength={500}
                  onChange={value => setStringSetting("ipfsApiUrl", value)}
                  onUseEnvironment={() => handBack("ipfsApiUrl", true)}
                  onKeep={() => handBack("ipfsApiUrl", false)}
                />
              </Section>

              <Section
                title="Single sign-on"
                summary={draft.flag.ssoEnabled ? "on" : "off"}
                forceOpen={Boolean(problems.identityIssuer)}
              >
                <FlagSetting
                  label="Accept sovrgnnet.cc accounts"
                  hint="People can sign in with an identity from the provider below instead of an account created here. Off means this server wants nothing to do with central identity, and stays fully usable that way."
                  checked={draft.flag.ssoEnabled}
                  source={data.ssoEnabledSource}
                  pending={draft.toEnvironment.ssoEnabled}
                  onChange={value => setFlagSetting("ssoEnabled", value)}
                  onUseEnvironment={() => handBack("ssoEnabled", true)}
                  onKeep={() => handBack("ssoEnabled", false)}
                />

                <TextSetting
                  label="Identity provider"
                  hint={`Whose tokens this server will trust, and whose keys it fetches to check them. Empty means ${IDENTITY_ORIGIN}.`}
                  placeholder={IDENTITY_ORIGIN}
                  value={draft.text.identityIssuer}
                  source={data.identityIssuerSource}
                  pending={draft.toEnvironment.identityIssuer}
                  problem={problems.identityIssuer}
                  maxLength={500}
                  onChange={value => setStringSetting("identityIssuer", value)}
                  onUseEnvironment={() => handBack("identityIssuer", true)}
                  onKeep={() => handBack("identityIssuer", false)}
                />
              </Section>

              <Section
                title="Advanced"
                summary={`${
                  draft.text.readyTimeoutMs
                    ? `${draft.text.readyTimeoutMs}ms`
                    : "default timeout"
                }${data.hasMetricsToken ? " · metrics locked" : ""}`}
                forceOpen={Boolean(problems.readyTimeoutMs)}
              >
                <SecretSetting
                  label="Metrics token"
                  hint="The bearer token /metrics demands. With none set, /metrics answers anybody who can reach the port."
                  isSet={data.hasMetricsToken}
                  source={data.metricsTokenSource}
                  value={draft.secret.metricsToken}
                  off={draft.secretOff.metricsToken}
                  pending={draft.toEnvironment.metricsToken}
                  onChange={value => setSecret("metricsToken", value)}
                  onRemove={() => removeSecret("metricsToken", true)}
                  onUseEnvironment={() => handBack("metricsToken", true)}
                  onKeep={() => removeSecret("metricsToken", false)}
                />

                <TextSetting
                  label="Readiness timeout (ms)"
                  hint="How long /ready waits on each dependency before calling it down. Empty hands it back to the environment, or to the 3000ms default. Long values turn a health probe into a hang that a load balancer reads as 'still connecting, fine'."
                  placeholder="3000"
                  value={draft.text.readyTimeoutMs}
                  source={data.readyTimeoutMsSource}
                  problem={problems.readyTimeoutMs}
                  maxLength={5}
                  onChange={value => setText("readyTimeoutMs", value)}
                />
              </Section>

              {/* Facts an admin needs, that this dialog deliberately can't
                  change: the Matrix name is permanent, and whether encryption
                  can be offered is derived from the deployment, not chosen
                  here. Each now says so on screen — the read-only ones are the
                  three most likely to be mistaken for missing fields. */}
              <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-3 space-y-1.5">
                <p className="text-[11px] text-slate-500 font-mono">
                  {data.matrixServerName} · v{data.version} · {data.instanceId}
                </p>
                <p className="text-xs text-slate-400">
                  <span className="text-slate-300">Matrix name</span> is fixed
                  at install: every user ID and every event already federated
                  carries it, and changing it would strand all of them.
                </p>
                <p className="text-xs text-slate-400">
                  <span className="text-slate-300">Instance ID</span> is derived
                  from that name rather than stored, so it survives a restore
                  and can't be pointed at somebody else's identity.
                </p>
                {data.encryption ? (
                  <p className="text-xs text-slate-400 flex items-start gap-1.5">
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    New channels are end-to-end encrypted — you can't read them.
                    Channels from before encryption, and all metadata, you can.
                    Derived from the deployment: it needs a reachable homeserver
                    and event ingest, so it isn't a switch.
                  </p>
                ) : (
                  <p className="text-xs text-amber-400/90 flex items-start gap-1.5">
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    Messages on this server are not end-to-end encrypted. You
                    can read them. Derived from the deployment: it needs a
                    reachable homeserver and event ingest, so it isn't a switch.
                  </p>
                )}
              </div>
            </div>

            {/* Outside the scroll, because an error about a field you have
                scrolled past is an error nobody reads. */}
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
              disabled={
                !data || !draft || save.isPending || blocked || !changed
              }
              onClick={() => save.mutate(patch)}
            >
              {save.isPending && (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              )}
              {saved && <Check className="w-4 h-4 mr-2" />}
              {saved ? "Saved" : "Save"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
