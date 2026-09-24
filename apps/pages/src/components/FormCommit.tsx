import type { ReactNode, Ref } from "react";
import { IconCheck } from "./Icons.js";

/**
 * The key that commits a form of several fields.
 *
 * A form of one field ends that field's row (`.field-inline`, or a field
 * shell's tail). A form of several has no single row to end, and its commit
 * used to be a bare 16px glyph under the label column — a mark nobody could
 * name, alone on a row, a screen-width from the fields it saves. It is the
 * `.go` square instead, with its verb beside it in the margin voice
 * (docs/design/controls.md § 1): the same object at the foot of every form,
 * and a phone reads what it does without a long press.
 *
 * `children` are the form's other keys, which ride the same row.
 */
export function FormCommit({
  label,
  disabled = false,
  busy = false,
  icon,
  buttonRef,
  onClick,
  children,
}: {
  /** The verb, as the square's accessible name and as the words beside it. */
  label: string;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
  /** A commit that is not a submit (opening a provider's own page). */
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="go-row">
      <button
        ref={buttonRef}
        type={onClick ? "button" : "submit"}
        className="go"
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={label}
        title={label}
        onClick={onClick}
      >
        {icon ?? <IconCheck size={18} />}
      </button>
      <span className="go-verb" aria-hidden="true">
        {label}
      </span>
      {children}
    </div>
  );
}
