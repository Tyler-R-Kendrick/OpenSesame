import type { ReactNode } from "react";
import { IconX } from "../../components/Icons.js";

/**
 * One credential value drawn as the Websites row is drawn: its name in the label
 * column, the field beside it, and the remove × at the end of the line. A
 * credential with several values (an API key's header and its key) puts the ×
 * on its first line only. One line, never a block.
 */
export function CredentialLine({
  label,
  htmlFor,
  field,
  remove,
}: {
  label: string;
  /** The id of the control the label names. */
  htmlFor: string;
  field: ReactNode;
  remove?: { label: string; onRemove: () => void };
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      <div className="editor__uri editor__uri--cred">
        {field}
        {remove ? (
          <button
            type="button"
            className="icon-btn"
            aria-label={remove.label}
            title={remove.label}
            onClick={remove.onRemove}
          >
            <IconX size={17} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
