import { type ReactNode, useRef } from "react";
import { IconX } from "../../../components/Icons.js";
import { useModalFocus } from "../../../lib/modal-focus.js";

/**
 * The side sheet every Security ceremony opens in: a head with the method's
 * mark, its name and the close key, and the ceremony as its body — no line
 * under the name and no caption in a foot (`design-lint` `sheet-caption`). Focus is held inside while it is open and
 * Escape or the scrim closes it (docs/design/canvases/auth-flow).
 *
 * `busy` is a write in flight. The sheet does not close under it — not on
 * Escape, the scrim or the close key — because the person would never see how
 * the write ended; the close key stays in the tab order, marked
 * `aria-disabled`, so focus is never pulled out from under whoever holds it.
 */
export function SheetFrame({
  title,
  mark,
  busy = false,
  onClose,
  children,
}: {
  title: string;
  mark: ReactNode;
  /** A write is in flight: every road that closes the sheet is held. */
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const leave = () => {
    if (!busy) onClose();
  };
  useModalFocus(true, sheetRef, closeRef, leave);
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        aria-disabled={busy || undefined}
        onClick={leave}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label={title}
        aria-modal="true"
        aria-busy={busy || undefined}
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            {mark}
          </span>
          <div className="sheet__grow">
            <h2>{title}</h2>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={closeRef}
            aria-disabled={busy || undefined}
            onClick={leave}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
