import { ACCESS_MODES, type AccessMode } from "@shared/hosting";

/**
 * How people reach this server — the one question asked before it starts.
 *
 * Two cards, not a toggle, because the difference between them is the
 * difference between a private LAN service and a public website, and a
 * switch labelled "public" does not carry that. Each card says what it does
 * in the words a person who has never hosted anything would use, and the
 * tunnel card says out loud the one thing that will surprise them later:
 * the address changes when the server restarts.
 *
 * Nothing is preselected on first run. The point of asking is that the
 * person picks; a default with a highlighted card is a decision wearing the
 * costume of a question.
 */
export default function AccessChoice({
  value,
  onChange,
  disabled,
}: {
  value: AccessMode | null;
  onChange: (mode: AccessMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="choices" role="radiogroup" aria-label="How people reach your server">
      {ACCESS_MODES.map(mode => {
        const selected = value === mode.id;
        return (
          <button
            key={mode.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`choice${selected ? " is-selected" : ""}`}
            onClick={() => onChange(mode.id)}
            disabled={disabled}
          >
            <span className="choice-label">{mode.label}</span>
            <span className="choice-detail">{mode.detail}</span>
          </button>
        );
      })}
    </div>
  );
}
