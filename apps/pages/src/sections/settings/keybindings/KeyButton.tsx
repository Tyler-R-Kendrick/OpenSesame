import {
  CONTEXT_LABEL,
  type KeymapContext,
} from "@opensesame/app-core/lib/keymap/context.js";
import {
  parseSequence,
  spokenSequence,
} from "@opensesame/app-core/lib/keymap/notation.js";
import type { KeyCell } from "@opensesame/app-core/sections/settings/keymap-panel-model.js";
import { Keycaps } from "./Keycaps.js";

export function spoken(sequence: string): string {
  return spokenSequence(parseSequence(sequence) ?? [sequence]);
}

function className(key: KeyCell): string {
  return [
    "keycap-btn",
    key.source === "user" ? "keycap-btn--user" : "",
    key.scope ? "keycap-btn--scoped" : "",
    key.waits ? "keycap-btn--waits" : "",
    key.off ? "keycap-btn--off" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** " in the vault list", or nothing everywhere. */
function where(scope: KeymapContext | undefined): string {
  return scope ? ` ${CONTEXT_LABEL[scope]}` : "";
}

/**
 * One binding as a keycap. Pressing it records another key in its place; a
 * struck default brings itself back; a locked command's key is only drawn.
 * A key added or struck in one listing says so (ADR 0156 §6).
 */
export function KeyButton({
  cell,
  label,
  locked,
  scope,
  onChange,
  onRestore,
}: {
  cell: KeyCell;
  label: string;
  locked: boolean;
  /** The scope the table shows, where a restore lands. */
  scope?: KeymapContext;
  onChange: () => void;
  onRestore: () => void;
}) {
  const said = spoken(cell.sequence);
  if (locked) {
    // Another command may take a locked command's key; it stays drawn, struck.
    const struck = cell.source === "removed";
    const text = struck ? `${said} — taken by another command` : said;
    return (
      <span
        className={`keycap-btn keycap-btn--fixed${struck ? " keycap-btn--removed" : ""}`}
        role="img"
        aria-label={text}
        title={text}
      >
        <Keycaps sequence={cell.sequence} />
      </span>
    );
  }
  if (cell.source === "removed") {
    return (
      <button
        type="button"
        className={`keycap-btn keycap-btn--removed${cell.scope ? " keycap-btn--scoped" : ""}`}
        data-sequence={cell.sequence}
        aria-label={`Restore ${said} for ${label}${where(scope)}`}
        title={
          cell.scope
            ? `Restore ${said} — taken away${where(cell.scope)}`
            : `Restore ${said}${where(scope)} — a default you took away`
        }
        onClick={onRestore}
      >
        <Keycaps sequence={cell.sequence} />
      </button>
    );
  }
  const notes = [
    cell.source === "user" ? `yours${where(cell.scope)}` : "default",
    cell.waits ? "waits for a longer key" : "",
    cell.off ? "off while single-character keys are off" : "",
  ].filter(Boolean);
  return (
    <button
      type="button"
      className={className(cell)}
      data-sequence={cell.sequence}
      aria-label={`Change ${said} for ${label}${where(cell.scope)}`}
      title={`${said} · ${notes.join(", ")} — press to record another`}
      onClick={onChange}
    >
      <Keycaps sequence={cell.sequence} />
    </button>
  );
}
