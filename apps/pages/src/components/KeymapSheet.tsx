import { useRef } from "react";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconX } from "./Icons.js";

const KEYMAP = [
  ["j / k or arrows", "Move cursor"],
  ["l / h", "Open or climb"],
  ["gg / G", "First or last item"],
  ["Enter", "Open item"],
  ["/ / Esc", "Search or close"],
  ["y / u", "Copy secret or username"],
  ["e / x", "Edit or trash"],
  ["n / .", "New or favorite"],
  ["s", "Share once"],
  ["g v/c/a/i/s", "Go to a section"],
] as const;

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
              {KEYMAP.map(([keys, action]) => (
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
