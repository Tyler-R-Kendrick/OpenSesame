import { Link } from "react-router";
import { IconCheck, IconX } from "../../components/Icons.js";

/** Render after all fields so keyboard and visual order agree. */
export function EditorActions({
  busy,
  label,
  closeTo,
}: { busy: boolean; label: string; closeTo: string }) {
  return (
    <div className="editor__actions">
      <button
        type="submit"
        className="icon-btn editor__save"
        disabled={busy}
        aria-busy={busy}
        aria-label={label}
        title={label}
      >
        <IconCheck size={17} />
      </button>
      <Link
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
