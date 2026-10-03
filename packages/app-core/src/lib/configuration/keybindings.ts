import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { CORE_COMMANDS, keymapCommands } from "../keymap/commands.js";
import { readKeymap } from "../keymap/config.js";
import { defaultBindings } from "../keymap/effective.js";
import { canonicalSequence } from "../keymap/notation.js";

/** Flat `sequence → command` view of a keymap (ADR 0156 keeps it sparse). */
export type KeybindingMap = Record<string, string>;

/** Every default binding the core shell has, before any capability adds jumps. */
export const DEFAULT_KEYBINDINGS: Readonly<KeybindingMap> = Object.freeze(
  Object.fromEntries(defaultBindings(CORE_COMMANDS)),
);

export type KeybindingImportResult =
  | { ok: true; bindings: KeybindingMap }
  | { ok: false; message: string; bindings: KeybindingMap };

/**
 * Check a flat map of keys to command ids and lay it over `previous`. A
 * refused map changes nothing: the whole of it is read before any of it
 * counts, and the old map comes back.
 */
export function importKeybindings(
  candidate: BoundaryValue,
  previous?: KeybindingMap,
): KeybindingImportResult {
  const base = { ...(previous ?? DEFAULT_KEYBINDINGS) };
  if (!isJsonObject(candidate)) {
    return {
      ok: false,
      message: "Keybindings must be a mapping of keys to action ids.",
      bindings: base,
    };
  }
  const commands = keymapCommands();
  const read = readKeymap(
    { bindings: candidate },
    commands,
    defaultBindings(commands),
  );
  if (!read.ok) return { ok: false, message: read.message, bindings: base };
  const next = { ...base };
  for (const [written, target] of Object.entries(candidate)) {
    const sequence = canonicalSequence(written);
    if (sequence !== null && isString(target)) next[sequence] = target;
  }
  return { ok: true, bindings: next };
}

export function resetKeybindings() {
  return { ...DEFAULT_KEYBINDINGS };
}
