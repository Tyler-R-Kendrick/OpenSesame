import { Link } from "react-router";
import { IconCheck, IconX } from "../../components/Icons.js";

/**
 * Render after all fields so keyboard and visual order agree. The save is the
 * shared \`.go\` square with its verb beside it, so the row that ends the
 * editor names what it does instead of being two bare glyphs on a line.
 */
export function EditorActions({
  busy,
  label,
  closeTo,
}: { busy: boolean; label: string; closeTo: string }) {
  return (
    <div className="editor__actions go-row">
      <button
        type="submit"
        className="go"
        disabled={busy}
        aria-busy={busy}
        aria-label={label}
        title={label}
      >
        <IconCheck size={18} />
      </button>
      <span className="go-verb" aria-hidden="true">
        {label}
      </span>
      <Link
        data-pane-close={busy ? undefined : ""}
        className="icon-btn"
        aria-label="Cancel"
        title="Cancel"
        to={closeTo}
      >
        <IconX size={17} />
      </Link>
    </div>
  );
}
