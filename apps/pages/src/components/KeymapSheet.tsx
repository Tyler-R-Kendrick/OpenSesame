import {
  type KeymapCommand,
  NOP,
  keymapCommands,
} from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import {
  CONTEXT_LABEL,
  KEYMAP_CONTEXTS,
  type KeymapContext,
} from "@opensesame/app-core/lib/keymap/context.js";
import { targetLabel } from "@opensesame/app-core/lib/keymap/effective.js";
import {
  keycapLabel,
  parseSequence,
} from "@opensesame/app-core/lib/keymap/notation.js";
import {
  loadKeymap,
  subscribeKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { useRef, useSyncExternalStore } from "react";

import { GESTURE_HELP } from "../lib/gesture-help.js";
import { isTouchPointer } from "../lib/gestures.js";
import { keymapHelp } from "../lib/keymap.js";
import { useModalFocus } from "../lib/modal-focus.js";
import { IconX } from "./Icons.js";

import { useContributions } from "../bindings/contributions.js";
/**
 * A person's own keys as rows: everywhere first, then each listing's
 * (ADR 0150 §6), each saying where it holds.
 */
function yourKeys(keymap: KeymapConfig, commands: readonly KeymapCommand[]) {
  const said = (sequence: string) =>
    (parseSequence(sequence) ?? [sequence]).map(keycapLabel).join(" ");
  const row = (sequence: string, target: string, context?: KeymapContext) => {
    const where = context ? CONTEXT_LABEL[context] : null;
    const action =
      target === NOP
        ? ["unbound", where]
        : [
            `${targetLabel(target, commands)} (yours${where ? `, ${where}` : ""})`,
          ];
    return {
      id: `${context ?? ""}:${sequence}`,
      keys: said(sequence),
      action: action.filter(Boolean).join(" "),
    };
  };
  return [
    ...Object.entries(keymap.bindings).map(([sequence, target]) =>
      row(sequence, target),
    ),
    ...KEYMAP_CONTEXTS.flatMap((context) =>
      Object.entries(keymap.contexts?.[context] ?? {}).map(
        ([sequence, target]) => row(sequence, target, context),
      ),
    ),
  ];
}

export function KeymapSheet({
  open,
  close,
}: { open: boolean; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  useModalFocus(open, sheetRef, closeRef, close);
  // Re-render when a jump, the voice or the share is registered or revoked; the rows themselves come
  // from the same accessor the handler binds, so the sheet cannot advertise a
  // key the handler would swallow.
  useContributions("keymap-jump");
  useContributions("command-assist");
  useContributions("secret-share");
  // Under a finger the keys are not what is there to learn: the gestures are.
  const touch = isTouchPointer();
  const title = touch ? "Gestures" : "Keyboard shortcuts";
  const rows = touch ? GESTURE_HELP : keymapHelp();
  const keymap = useSyncExternalStore(subscribeKeymap, loadKeymap, loadKeymap);
  const commands = keymapCommands();
  // A person's own keys (ADR 0150), after the defaults: what they bound,
  // and the defaults they took away, so the sheet never promises a key the
  // handler would not run.
  const yours = touch ? [] : yourKeys(keymap, commands);

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
        aria-label={title}
      >
        <div className="sheet__head">
          <div className="sheet__grow">
            <h2>{title}</h2>
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
              {yours.map(({ id, keys, action }) => (
                <tr key={`yours-${id}`}>
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
