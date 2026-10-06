import { type ReactNode, type RefObject, useRef } from "react";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconX } from "./Icons.js";

/**
 * The side sheet a ceremony runs in: a mark, a name and the close key in the
 * head, the ceremony's card in the body, and nothing else — no line under the
 * title and no caption in a foot (`design-lint` `sheet-caption`): the card's
 * facts and keys say what the sheet does. A row's action opens it; closing it puts the person back
 * on the row they came from (`useModalFocus` returns the focus).
 *
 * The card inside is a `CeremonyShell`; this is only the frame, so a Settings
 * panel never draws a ceremony's fields on the page itself.
 */
export function CeremonySheet({
  title,
  mark,
  onClose,
  initialFocus,
  children,
}: {
  title: string;
  mark: ReactNode;
  onClose: () => void;
  /** Where focus lands on open, when it should be a field rather than Close. */
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useModalFocus(true, sheetRef, initialFocus ?? closeRef, onClose);
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
      </div>
    </div>
  );
}
