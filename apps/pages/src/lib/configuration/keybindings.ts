import { actionById, isBindableAction } from "./actions.js";

export type KeybindingMap = Record<string, string>;

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  "Control+l": "command.palette",
  ":": "command.palette",
  "/": "listing.search",
  j: "listing.next",
  x: "item.trash",
  s: "item.share",
  e: "item.edit",
  "?": "help.keymap",
};

const UNSAFE_TARGETS = /^(https?:|javascript:|data:|\/\/)/i;

export type KeybindingImportResult =
  | { ok: true; bindings: KeybindingMap }
  | { ok: false; message: string; bindings: KeybindingMap };

export function importKeybindings(
  candidate: unknown,
  previous: KeybindingMap = DEFAULT_KEYBINDINGS,
): KeybindingImportResult {
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    Array.isArray(candidate)
  ) {
    return {
      ok: false,
      message: "Keybindings must be a mapping of keys to action ids.",
      bindings: previous,
    };
  }
  const next: KeybindingMap = { ...previous };
  for (const [key, value] of Object.entries(candidate)) {
    if (typeof value !== "string") {
      return {
        ok: false,
        message: `Binding for "${key}" is not an action id.`,
        bindings: previous,
      };
    }
    if (UNSAFE_TARGETS.test(value) || value.includes("://")) {
      return {
        ok: false,
        message: "Keybindings cannot name URLs or endpoints.",
        bindings: previous,
      };
    }
    if (!actionById(value)) {
      return {
        ok: false,
        message: `Unknown action "${value}".`,
        bindings: previous,
      };
    }
    if (!isBindableAction(value)) {
      if (DEFAULT_KEYBINDINGS[key] === value) {
        next[key] = value;
        continue;
      }
      return {
        ok: false,
        message: `Action "${value}" requires confirmation and cannot be rebound to skip it.`,
        bindings: previous,
      };
    }
    next[key] = value;
  }
  return { ok: true, bindings: next };
}

export function resetKeybindings(): KeybindingMap {
  return { ...DEFAULT_KEYBINDINGS };
}
