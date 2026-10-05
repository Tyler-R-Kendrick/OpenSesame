/**
 * Whether the owner has supplied what a mode's input asks for. One reading for
 * the sheet (to enable the key) and for arming (to refuse before sealing), so
 * the two cannot disagree about what is enough.
 */

import type { DuressMode } from "./mode.js";

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
    case "confirm":
      return (
        (extras[input.id] ?? "").trim().toLowerCase() ===
        input.word.trim().toLowerCase()
      );
  }
}
