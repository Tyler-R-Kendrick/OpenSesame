/**
 * Where a person's keymap lives: the host's local store, sealed at rest like
 * every other value there (ADR 0149). One live copy, read at call time, with
 * listeners so Settings and the `?` sheet redraw when it changes.
 *
 * A store can refuse a read, a write or a removal (a full quota, a blocked
 * origin), so none of them is trusted to succeed: a keymap that could not be
 * written is refused, never kept in memory as though it had been saved.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { type WebStorage, maybeLocalStore } from "../../ports.js";
import { keymapCommands } from "./commands.js";
import {
  EMPTY_KEYMAP,
  type KeymapConfig,
  type KeymapResult,
  keymapJson,
  readKeymap,
} from "./config.js";
import { defaultBindings } from "./effective.js";
import { keysForgotten } from "./gesture-bindings.js";
import { canonicalSequence } from "./notation.js";
import { keymapFingerprint, salvageKeymap } from "./salvage.js";

export const KEYMAP_KEY = "opensesame.keymap.v2";
/** The flat `key → action` map every earlier build wrote, defaults included. */
export const LEGACY_KEYMAP_KEY = "opensesame.keybindings.v1";

function webStorage(): WebStorage | undefined {
  try {
    return maybeLocalStore();
  } catch {
    return undefined;
  }
}

let live: KeymapConfig = EMPTY_KEYMAP;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

type Item = { ok: true; value: string | null } | { ok: false };

function getItem(storage: WebStorage, key: string): Item {
  try {
    return { ok: true, value: storage.getItem(key) };
  } catch {
    return { ok: false };
  }
}

function putItem(storage: WebStorage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function dropItem(storage: WebStorage, key: string): boolean {
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

/** The old flat map, reduced to what differs from today's defaults. */
function migrateLegacy(raw: string): KeymapConfig | null {
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return null;
    const bindings: Record<string, string> = {};
    for (const [written, target] of Object.entries(parsed)) {
      const sequence = canonicalSequence(written);
      if (sequence !== null && isString(target)) bindings[sequence] = target;
    }
    return salvageKeymap({ bindings });
  } catch {
    return null;
  }
}

/** What storage held: a keymap, nothing, or a store that would not answer. */
type Stored =
  | { state: "found"; config: KeymapConfig }
  | { state: "empty" }
  | { state: "unreadable" };

/** Stored data keeps every entry that still passes (`salvage.ts`). */
function readCurrent(raw: string): Stored {
  try {
    return { state: "found", config: salvageKeymap(JSON.parse(raw)) };
  } catch {
    return { state: "empty" };
  }
}

/**
 * The v1 map moves to v2 once, in memory first. A refused write leaves the
 * v1 key where it is, so the next load (or save) tries again.
 */
function readLegacy(storage: WebStorage): Stored {
  const legacy = getItem(storage, LEGACY_KEYMAP_KEY);
  if (!legacy.ok) return { state: "unreadable" };
  if (!legacy.value) return { state: "empty" };
  const migrated = migrateLegacy(legacy.value);
  if (migrated === null) return { state: "empty" };
  const written = putItem(
    storage,
    KEYMAP_KEY,
    JSON.stringify(keymapJson(migrated)),
  );
  if (written) dropItem(storage, LEGACY_KEYMAP_KEY);
  return { state: "found", config: migrated };
}

function readStored(storage: WebStorage | undefined): Stored {
  if (!storage) return { state: "empty" };
  const item = getItem(storage, KEYMAP_KEY);
  if (!item.ok) return { state: "unreadable" };
  return item.value ? readCurrent(item.value) : readLegacy(storage);
}

/** The keymap in force, reading storage the first time it is asked for. */
export function loadKeymap(): KeymapConfig {
  if (loaded) return live;
  const stored = readStored(webStorage());
  // A store that would not answer is asked again next time, not taken for
  // an empty keymap.
  if (stored.state === "unreadable") return live;
  loaded = true;
  if (stored.state === "found") live = stored.config;
  return live;
}

/** Re-read storage: another tab, or a test, changed it underneath. */
export function reloadKeymap(): KeymapConfig {
  const stored = readStored(webStorage());
  if (stored.state !== "unreadable") {
    loaded = true;
    live = stored.state === "found" ? stored.config : EMPTY_KEYMAP;
  }
  emit();
  return live;
}

/**
 * Take up what another tab saved. Storage is read again, and the listeners
 * hear only when the stored keymap differs from the live one, so a `storage`
 * or focus listener may call this as often as it likes. A store that will not
 * answer, or that is absent, changes nothing. True when the keymap changed.
 */
export function refreshKeymap(): boolean {
  const storage = webStorage();
  if (!storage) return false;
  const stored = readStored(storage);
  if (stored.state === "unreadable") return false;
  const next = stored.state === "found" ? stored.config : EMPTY_KEYMAP;
  loaded = true;
  if (keymapFingerprint(next) === keymapFingerprint(live)) return false;
  live = next;
  emit();
  return true;
}

const NOT_SAVED = "The keymap could not be saved on this device.";
const NOT_RESET = "The keymap could not be reset on this device.";

/**
 * Keep a keymap written as data (the stored JSON, the parsed file). The live
 * copy changes only once storage has taken it.
 */
export function saveKeymapData(candidate: BoundaryValue): KeymapResult {
  const commands = keymapCommands();
  const read = readKeymap(candidate, commands, defaultBindings(commands));
  if (!read.ok) return read;
  const storage = webStorage();
  if (storage) {
    const json = JSON.stringify(keymapJson(read.config));
    if (!putItem(storage, KEYMAP_KEY, json))
      return { ok: false, message: NOT_SAVED };
    dropItem(storage, LEGACY_KEYMAP_KEY);
  }
  loaded = true;
  live = read.config;
  emit();
  return read;
}

/** Validate and keep a keymap. A refused one leaves the live copy as it was. */
export function saveKeymap(config: KeymapConfig): KeymapResult {
  return saveKeymapData(overlapCast(keymapJson(config)));
}

/**
 * Forget every change: the defaults, no macros, character keys on. As with a
 * save, the live copy changes only once storage has taken it, and a refused
 * reset leaves storage as it was. The empty keymap is written first, so a
 * store that will not take it is refused before anything is removed; after
 * that the legacy key goes, and the empty keymap's own key last, so no
 * ordering can end with the new key gone and the old map still there to
 * return on the next load.
 */
export function resetKeymap(): KeymapResult {
  const storage = webStorage();
  if (storage) {
    if (!putItem(storage, KEYMAP_KEY, JSON.stringify(keymapJson(EMPTY_KEYMAP))))
      return { ok: false, message: NOT_RESET };
    // The empty keymap now outranks a legacy map that would not go; the
    // removal of its own key is tidiness, not safety.
    if (dropItem(storage, LEGACY_KEYMAP_KEY)) dropItem(storage, KEYMAP_KEY);
  }
  loaded = true;
  live = EMPTY_KEYMAP;
  emit();
  return { ok: true, config: live };
}

/**
 * Forget every key and macro, and keep the gestures that name none: the
 * Keyboard tab's reset (ADR 0167). Written as one save, so a store that will
 * not take it is refused and the live keymap stays as it was.
 */
export function resetKeys(): KeymapResult {
  const result = saveKeymap(keysForgotten(loadKeymap()));
  return result.ok ? result : { ok: false, message: NOT_RESET };
}

/** Forget the live copy, as a fresh page load would (tests). */
export function forgetKeymapForTest(): void {
  loaded = false;
  live = EMPTY_KEYMAP;
}

export function subscribeKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
