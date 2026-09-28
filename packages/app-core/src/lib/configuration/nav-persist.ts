import type { BoundaryValue } from "@opensesame/os-domain";
import { type WebStorage, maybeLocalStore } from "../../ports.js";
import { isBindableAction } from "./actions.js";

import {
  DEFAULT_KEYBINDINGS,
  type KeybindingMap,
  importKeybindings,
} from "./keybindings.js";

const KEYBINDINGS_KEY = "opensesame.keybindings.v1";

function webStorage(): WebStorage | undefined {
  try {
    return maybeLocalStore();
  } catch {
    return undefined;
  }
}

let liveBindings: KeybindingMap = { ...DEFAULT_KEYBINDINGS };

export function loadKeybindings(): KeybindingMap {
  try {
    const raw = webStorage()?.getItem(KEYBINDINGS_KEY);
    if (!raw) return liveBindings;
    const imported = importKeybindings(JSON.parse(raw), DEFAULT_KEYBINDINGS);
    if (imported.ok) liveBindings = imported.bindings;
  } catch {
    /* keep previous map */
  }
  return liveBindings;
}

export function persistKeybindings(
  candidate: BoundaryValue,
): ReturnType<typeof importKeybindings> {
  const imported = importKeybindings(candidate, liveBindings);
  if (!imported.ok) return imported;
  liveBindings = imported.bindings;
  webStorage()?.setItem(KEYBINDINGS_KEY, JSON.stringify(liveBindings));
  return imported;
}

export function currentKeybindings(): KeybindingMap {
  return liveBindings;
}

export function bindingChord(event: KeyboardEvent): string {
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return `Control+${event.key}`;
  }
  if (event.shiftKey && event.key === "?") return "Shift+?";
  return event.key;
}

export type BindableRunners = {
  "command.palette": () => void;
  "listing.search": () => void;
  "listing.next": (event: KeyboardEvent) => void;
  "item.edit": () => void;
  "help.keymap": () => void;
};

export function keysForAction(actionId: string): string[] {
  return Object.entries(loadKeybindings())
    .filter(([, id]) => id === actionId)
    .map(([key]) => key);
}

export function resetLiveKeybindings(): KeybindingMap {
  liveBindings = { ...DEFAULT_KEYBINDINGS };
  webStorage()?.removeItem(KEYBINDINGS_KEY);
  return liveBindings;
}

/**
 * Live user bindings overlay the hardcoded tinykeys map. Authority actions
 * stay on their default keys; they cannot be rebound to skip confirmation.
 */
export function dispatchUserBinding(
  event: KeyboardEvent,
  isTyping: boolean,
  run: BindableRunners,
): boolean {
  if (isTyping || event.metaKey || event.altKey || event.isComposing)
    return false;
  const map = loadKeybindings();
  const action = map[bindingChord(event)] ?? map[event.key];
  if (!action || !isBindableAction(action)) return false;
  event.preventDefault();
  if (action === "listing.next") run["listing.next"](event);
  else if (action === "command.palette") run["command.palette"]();
  else if (action === "listing.search") run["listing.search"]();
  else if (action === "item.edit") run["item.edit"]();
  else if (action === "help.keymap") run["help.keymap"]();
  else return false;
  return true;
}
