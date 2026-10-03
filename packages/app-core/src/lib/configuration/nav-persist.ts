import {
  type BoundaryValue,
  isJsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { keymapCommands } from "../keymap/commands.js";
import { keymapJson } from "../keymap/config.js";
import { effectiveBindings } from "../keymap/effective.js";
import { loadKeymap, resetKeymap, saveKeymapData } from "../keymap/store.js";
import {
  type KeybindingImportResult,
  type KeybindingMap,
  importKeybindings,
} from "./keybindings.js";

/** The keymap in force as a flat map: defaults with a person's changes. */
export function loadKeybindings(): KeybindingMap {
  return Object.fromEntries(effectiveBindings(loadKeymap(), keymapCommands()));
}

/**
 * Lay a flat map of keys over the person's keymap (ADR 0156). A key that
 * restates its default is dropped rather than kept, so the stored keymap only
 * ever holds what the person changed.
 */
export function persistKeybindings(
  candidate: BoundaryValue,
): KeybindingImportResult {
  const imported = importKeybindings(candidate, loadKeybindings());
  if (!imported.ok || !isJsonObject(candidate)) return imported;
  const current = loadKeymap();
  // Macros and context keys ride along untouched.
  const saved = saveKeymapData(
    overlapCast({
      ...keymapJson(current),
      bindings: { ...current.bindings, ...candidate },
    }),
  );
  return saved.ok
    ? { ok: true, bindings: loadKeybindings() }
    : { ok: false, message: saved.message, bindings: loadKeybindings() };
}

export function currentKeybindings(): KeybindingMap {
  return loadKeybindings();
}

/** Every sequence that runs `actionId` right now. */
export function keysForAction(actionId: string): string[] {
  return Object.entries(loadKeybindings())
    .filter(([, id]) => id === actionId)
    .map(([key]) => key);
}

export function resetLiveKeybindings(): KeybindingMap {
  resetKeymap();
  return loadKeybindings();
}
