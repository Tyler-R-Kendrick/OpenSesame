/**
 * Whether the owner has supplied what a mode's input asks for. One reading for
 * the sheet (to enable the key) and for arming (to refuse before sealing), so
 * the two cannot disagree about what is enough.
 */

import type { DuressContext, DuressMode } from "./mode.js";

export type ModeExtras = Readonly<Record<string, string>>;

/** The lines of an `items` value: trimmed, blanks dropped. */
export function itemLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function inputReady(mode: DuressMode, extras: ModeExtras): boolean {
  const { input } = mode;
  switch (input.kind) {
    case "none":
      return true;
    case "text":
      return (extras[input.id] ?? "").trim().length > 0;
    case "choice":
      return input.options.some((option) => option.value === extras[input.id]);
    case "items": {
      const lines = itemLines(extras[input.id] ?? "");
      return (
        lines.length >= input.min &&
        lines.length <= input.max &&
        lines.every((line) => line.length <= input.maxLength)
      );
    }
    case "pick": {
      const ids = itemLines(extras[input.id] ?? "");
      return (
        new Set(ids).size === ids.length &&
        ids.length >= input.min &&
        ids.length <= input.max
      );
    }
    case "confirm":
      return (
        (extras[input.id] ?? "").trim().toLowerCase() ===
        input.word.trim().toLowerCase()
      );
  }
}

/**
 * What the sheet puts in a mode's input when the mode is picked: the starter
 * lines of an `items` input, one per line, and nothing for any other kind.
 */
export function starterText(mode: DuressMode): string {
  const { input } = mode;
  return input.kind === "items" ? (input.starter ?? []).join("\n") : "";
}

/**
 * Whether the sheet draws `mode` at all. A mode that picks among rows is
 * offered only when the open vault gives it rows to pick; one that does not
 * pick is always offered. Absent when it cannot act, never drawn disabled.
 */
export function isOffered(mode: DuressMode, context: DuressContext): boolean {
  if (mode.input.kind !== "pick") return true;
  return (mode.rows?.(context).length ?? 0) >= mode.input.min;
}

/** The modes of `modes` the sheet draws for this device, in their order. */
export function offeredModes<Mode extends DuressMode>(
  modes: readonly Mode[],
  context: DuressContext,
): Mode[] {
  return modes.filter((mode) => isOffered(mode, context));
}
