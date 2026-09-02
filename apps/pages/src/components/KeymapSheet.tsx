import { useRef } from "react";
import { KEYMAP_HELP } from "../lib/keymap.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconX } from "./Icons.js";

export function KeymapSheet({
  open,
  close,
}: { open: boolean; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  useModalFocus(open, sheetRef, closeRef, close);

  if (!open) return null;
  return (
    <div className="sheet-layer">
      <button
        type="button"
        className="scrim"
        aria-label="Close"
        onClick={close}
      />
      <section
        ref={sheetRef}
        className="sheet keymap"
        // biome-ignore lint/a11y/useSemanticElements: native <dialog open> inerts the page and conflicts with the shared sheet layer
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>Keyboard shortcuts</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={close}
          >
            <IconX size={18} />
          </button>
        </div>
        <div className="sheet__body">
          <table className="keymap__table">
            <tbody>
              {KEYMAP_HELP.map(([keys, action]) => (
                <tr key={keys}>
                  <th scope="row">
                    <kbd>{keys}</kbd>
                  </th>
                  <td>{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
