import type { EditorMode } from "@opensesame/app-core/lib/configuration/draft.js";
import "./configuration.css";

export function ModeToggle(props: {
  mode: EditorMode;
  onMode: (mode: EditorMode) => void;
  dirty?: boolean;
}) {
  return (
    <div
      className="cfg-mode"
      role="radiogroup"
      aria-label="Editor representation"
    >
      <button
        type="button"
        className="cfg-mode__btn"
        aria-pressed={props.mode === "visual"}
        onClick={() => props.onMode("visual")}
      >
        Visual
      </button>
      <button
        type="button"
        className="cfg-mode__btn"
        aria-pressed={props.mode === "source"}
        onClick={() => props.onMode("source")}
      >
        Source
      </button>
      {props.dirty ? <span className="cfg-mode__dirty">Unsaved</span> : null}
    </div>
  );
}
