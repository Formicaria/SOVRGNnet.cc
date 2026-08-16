import { useEffect, useState } from "react";
import { checkForUpdate, shouldPrompt, type UpdateCheck } from "@shared/updates";
import { openExternal } from "@/lib/bridge";

const DISMISSED_VERSION = "sovrgnnet.update.dismissedVersion";
const DISMISSED_AT = "sovrgnnet.update.dismissedAt";

/**
 * Tells someone a newer version exists, on launch.
 *
 * Deliberately advisory rather than automatic. Once the app bundles a
 * homeserver and a database (ADR 0005), an update can be replacing software
 * that other people are actively talking through — doing that without asking,
 * on a machine somebody owns, would be rude at best.
 *
 * It also can't be a routine nag. Prompting every launch is how people learn
 * to dismiss update dialogs unread, which is exactly the habit that gets a
 * security fix ignored. So: a routine update asks once a week, a security
 * release asks every time.
 */
export default function UpdatePrompt({ currentVersion }: { currentVersion: string }) {
  const [check, setCheck] = useState<UpdateCheck | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await checkForUpdate(currentVersion);
      if (cancelled) return;

      const dismissedVersion = localStorage.getItem(DISMISSED_VERSION);
      const dismissedAt = Number(localStorage.getItem(DISMISSED_AT)) || null;

      if (shouldPrompt(result, dismissedVersion, dismissedAt)) {
        setCheck(result);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentVersion]);

  if (check?.status !== "available") return null;

  const { release, urgency } = check;

  const dismiss = () => {
    localStorage.setItem(DISMISSED_VERSION, release.version);
    localStorage.setItem(DISMISSED_AT, String(Date.now()));
    setCheck(null);
  };

  return (
    <div className={`update${urgency === "security" ? " is-security" : ""}`} role="status">
      <div className="update-text">
        <strong>
          {urgency === "security"
            ? `Security update available — ${release.version}`
            : `Version ${release.version} is available`}
        </strong>
        <span>
          {urgency === "security"
            ? "This release fixes a security issue. Updating soon is worth it."
            : `You're on ${currentVersion}.`}
        </span>
      </div>

      <div className="update-actions">
        <button className="ghost" onClick={dismiss}>
          {urgency === "security" ? "Remind me" : "Not now"}
        </button>
        <button
          className="primary"
          onClick={() => {
            void openExternal(release.url);
            dismiss();
          }}
        >
          Get it
        </button>
      </div>
    </div>
  );
}
