import { type ReactNode, useRef } from "react";
import { IconX } from "../../../components/Icons.js";
import { useModalFocus } from "../../../lib/modal-focus.js";

/**
 * The side sheet every Security ceremony opens in: a head with the method's
 * mark, name and one line, the ceremony as its body, and a foot that says
 * what is and is not written yet. Focus is held inside while it is open and
 * Escape or the scrim closes it (docs/design/canvases/auth-flow).
 */
export function SheetFrame({
  title,
  subtitle,
  mark,
  foot,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  mark: ReactNode;
  foot: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  useModalFocus(true, sheetRef, closeRef, onClose);
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div
        ref={sheetRef}
        className="sheet"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and paints a blank top-layer surface
        role="dialog"
        aria-label={title}
        aria-modal="true"
      >
        <div className="sheet__head">
          <span className="sheet__mark" aria-hidden="true">
            {mark}
          </span>
          <div className="sheet__grow">
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            ref={closeRef}
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        <div className="sheet__foot">
          <p className="hint">{foot}</p>
        </div>
      </div>
    </div>
  );
}
