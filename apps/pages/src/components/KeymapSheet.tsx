import { useRef } from "react";
import { keysForAction } from "../lib/configuration/nav-persist.js";

import { keymapHelp } from "../lib/keymap.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconX } from "./Icons.js";

import { useContributions } from "../bindings/contributions.js";
export function KeymapSheet({
  open,
  close,
}: { open: boolean; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  useModalFocus(open, sheetRef, closeRef, close);
  // Re-render when a jump is registered or revoked; the rows themselves come
  // from the same accessor the handler binds, so the sheet cannot advertise a
  // key the handler would swallow.
  useContributions("keymap-jump");
  const rows = keymapHelp();

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
              {rows.map(([keys, action]) => (
                <tr key={keys}>
                  <th scope="row">
                    <kbd>{keys}</kbd>
                  </th>
                  <td>{action}</td>
                </tr>
              ))}
              {keysForAction("item.edit").map((key) =>
                key === "e" ? null : (
                  <tr key={`custom-${key}`}>
                    <th scope="row">
                      <kbd>{key}</kbd>
                    </th>
                    <td>Edit (custom)</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
