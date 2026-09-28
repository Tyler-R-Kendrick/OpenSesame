import { type ReactNode, useRef } from "react";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconX } from "./Icons.js";

/**
 * The side sheet a ceremony runs in: a mark and a name in the head, the
 * ceremony's card in the body, and one line of what is and is not written
 * yet in the foot. A row's action opens it; closing it puts the person back
 * on the row they came from (`useModalFocus` returns the focus).
 *
 * The card inside is a `CeremonyShell`; this is only the frame, so a Settings
 * panel never draws a ceremony's fields on the page itself.
 */
export function CeremonySheet({
  title,
  mark,
  foot,
  onClose,
  children,
}: {
  title: string;
  mark: ReactNode;
  foot?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
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
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
        {foot ? (
          <div className="sheet__foot">
            <p className="hint">{foot}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
