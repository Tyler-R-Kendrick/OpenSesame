import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { IconDownload, IconUpload } from "../../components/Icons.js";
import "./add-slide.css";
import type { SlideState } from "./add-slide.js";

/** The icon of a zone: the one the entry's own key wears on a desktop. */
const MARKS = { up: IconDownload, down: IconUpload } as const;

/** The gap between the held button and a zone, in px. */
const GAP = 4;
const CELL = 44;
const CELL_MIN = 28;

/**
 * The drag area drawn while the Add button is held: a zone above the button
 * and one below it, each a sharp square in the button's own column with its
 * label beside it, the one the finger is over inked. It is drawn on the body,
 * in fixed coordinates, because the pane it belongs to clips its own box and
 * the lower zone lives in the statusline's space.
 *
 * It is the touch road only and carries no semantics (a screen reader is given
 * the same entries as a menu), so it is hidden from the accessibility tree.
 */
export function AddSlide({ slide }: { slide: SlideState }) {
  const { box, zones, over } = slide;
  const above = box.top - GAP;
  const below = window.innerHeight - box.bottom - GAP;
  const cell = Math.max(CELL_MIN, Math.min(CELL, above, below));
  const reach = cell + GAP;
  const style: CSSProperties & Record<"--add-slide-cell", string> = {
    left: box.left,
    top: box.top - reach,
    width: box.width,
    height: box.height + reach * 2,
    "--add-slide-cell": `${cell}px`,
  };
  return createPortal(
    <div className="add-slide" aria-hidden="true" style={style}>
      {(["up", "down"] as const).map((way) => {
        const entry = zones[way];
        if (!entry) return null;
        const Mark = MARKS[way];
        return (
          <div
            key={way}
            className={`add-slide__zone add-slide__zone--${way}`}
            data-active={over === way ? "true" : undefined}
          >
            <span className="add-slide__label">{entry.label}</span>
            <Mark size={20} />
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
