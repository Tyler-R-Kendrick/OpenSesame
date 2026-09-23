import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { actionById, isBindableAction } from "./actions.js";

export type KeybindingMap = Record<string, string>;

export const DEFAULT_KEYBINDINGS = {
  "Control+l": "command.palette",
  ":": "command.palette",
  "/": "listing.search",
  j: "listing.next",
  x: "item.trash",
  s: "item.share",
  e: "item.edit",
  "?": "help.keymap",
} satisfies KeybindingMap;

const UNSAFE_TARGETS = /^(https?:|javascript:|data:|\/\/)/i;

export type KeybindingImportResult =
  | { ok: true; bindings: KeybindingMap }
  | { ok: false; message: string; bindings: KeybindingMap };

export function importKeybindings(
  candidate: BoundaryValue,
  previous?: KeybindingMap,
): KeybindingImportResult {
  const base: KeybindingMap = {};
  Object.assign(base, previous ?? DEFAULT_KEYBINDINGS);
  if (!isJsonObject(candidate)) {
    return {
      ok: false,
      message: "Keybindings must be a mapping of keys to action ids.",
      bindings: base,
    };
  }
  const next: KeybindingMap = {};
  Object.assign(next, base);
  for (const [key, value] of Object.entries(candidate)) {
    if (!isString(value)) {
      return {
        ok: false,
        message: `Binding for "${key}" is not an action id.`,
        bindings: base,
      };
    }
    if (UNSAFE_TARGETS.test(value) || value.includes("://")) {
      return {
        ok: false,
        message: "Keybindings cannot name URLs or endpoints.",
        bindings: base,
      };
    }
    if (!actionById(value)) {
      return {
        ok: false,
        message: `Unknown action "${value}".`,
        bindings: base,
      };
    }
    if (!isBindableAction(value)) {
      const defaults: KeybindingMap = {};
      Object.assign(defaults, DEFAULT_KEYBINDINGS);
      if (defaults[key] === value) {
        next[key] = value;
        continue;
      }
      return {
        ok: false,
        message: `Action "${value}" requires confirmation and cannot be rebound to skip it.`,
        bindings: base,
      };
    }
    next[key] = value;
  }
  return { ok: true, bindings: next };
}

export function resetKeybindings() {
  const next: KeybindingMap = {};
  Object.assign(next, DEFAULT_KEYBINDINGS);
  return next;
}
