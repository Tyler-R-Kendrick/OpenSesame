import type { ReactNode } from "react";
import { useId } from "react";

/**
 * One control shell for every text input outside the vault editor.
 *
 * A bare bordered `<input>` gives an operator nothing: no sense of which plane
 * a URL belongs to, no room for the state the field already knows, and no way
 * to offer a value we could have filled in ourselves. The shell is a single
 * 40px row holding a leading glyph, the input, and a tail for the state chip
 * or a reveal button — with the values we already know offered as one-tap
 * fills underneath.
 */
export type FieldFill = {
  /** Shown on the chip, and the value applied unless `value` says otherwise. */
  label: string;
  value?: string;
  onPick: () => void;
};

export function FieldShell({
  id,
  label,
  value,
  onValueChange,
  onCommit,
  type = "text",
  placeholder,
  autoComplete,
  inputMode,
  lead,
  tail,
  status,
  hint,
  fills,
  mono = false,
  disabled = false,
  readOnly = false,
}: {
  id?: string;
  label: string;
  value: string;
  onValueChange?: (next: string) => void;
  /** Settings commit on blur — there is no Save button to press. */
  onCommit?: (next: string) => void;
  type?: "text" | "url" | "password" | "email";
  placeholder?: string;
  autoComplete?: string;
  /** A numeric or telephone keyboard on a phone, for codes and numbers. */
  inputMode?: "numeric" | "tel" | "email";
  lead?: ReactNode;
  tail?: ReactNode;
  /** Rendered beside the label — a `.chip` saying Saved, Reachable, Not set. */
  status?: ReactNode;
  hint?: ReactNode;
  fills?: FieldFill[];
  /** URLs and secrets set in the mono face; prose stays in the UI face. */
  mono?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}) {
  const generated = useId();
  const inputId = id ?? generated;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className="f">
      {/* The status chip sits beside the label, never inside it — folded in,
          its text becomes part of the input's accessible name. */}
      <div className="f__labelrow">
        <label className="f__label" htmlFor={inputId}>
          {label}
        </label>
        {status}
      </div>
      <div className="f__shell">
        {lead ? (
          <span className="f__lead" aria-hidden="true">
            {lead}
          </span>
        ) : null}
        <input
          id={inputId}
          type={type}
          className={mono ? "f__input f__input--mono" : "f__input"}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          inputMode={inputMode}
          disabled={disabled}
          readOnly={readOnly}
          aria-describedby={hintId}
          onChange={(event) => onValueChange?.(event.target.value)}
          onBlur={(event) => onCommit?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && onCommit) {
              event.currentTarget.blur();
            }
          }}
        />
        {tail ? <span className="f__tail">{tail}</span> : null}
      </div>
      {fills && fills.length > 0 ? (
        <div className="f__fills">
          <span className="f__fills-label">Fill with</span>
          {fills.map((fill) => (
            <button
              key={fill.label}
              type="button"
              className="fill"
              onClick={() => {
                fill.onPick();
                onCommit?.(fill.value ?? fill.label);
              }}
            >
              {fill.label}
            </button>
          ))}
        </div>
      ) : null}
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
