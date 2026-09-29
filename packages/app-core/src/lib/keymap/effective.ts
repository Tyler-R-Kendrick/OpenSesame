/**
 * The keymap in force: the defaults, with a person's changes laid over them.
 * Everything that reads keys — the shell's handler, the `?` sheet, Settings ›
 * Keybindings — reads this one map, so none of them can disagree.
 */
import {
  type CommandKind,
  type KeymapCommand,
  MACRO_PREFIX,
  NOP,
  commandById,
} from "./commands.js";
import {
  type KeymapBindings,
  type KeymapConfig,
  layBindings,
  macroName,
} from "./config.js";
import { KEYMAP_CONTEXTS, type KeymapContext } from "./context.js";
import { isCharacterKey, parseSequence } from "./notation.js";

/** Default sequence → command id, first claim wins. */
export function defaultBindings(
  commands: readonly KeymapCommand[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const command of commands) {
    for (const sequence of command.defaults) {
      if (!map.has(sequence)) map.set(sequence, command.id);
    }
  }
  return map;
}

/** Off when the person turned character keys off: its first key is one. */
export function characterSequence(sequence: string): boolean {
  const first = parseSequence(sequence)?.[0];
  return first !== undefined && isCharacterKey(first);
}

/**
 * Sequence → target, with unbinds applied and the single-key switch read.
 * With a `context`, that context's keys are laid over the global ones: the
 * keymap in force while the keyboard is in that listing.
 */
export function effectiveBindings(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  context?: KeymapContext,
): Map<string, string> {
  const map = layBindings(
    defaultBindings(commands),
    config.bindings,
    config.macros,
  );
  if (context !== undefined)
    layBindings(map, scopeBindings(config, context), config.macros);
  if (!config.singleKeys) {
    for (const sequence of [...map.keys()]) {
      if (characterSequence(sequence)) map.delete(sequence);
    }
  }
  return map;
}

/** The bindings one scope holds: the global layer, or a context's overlay. */
export function scopeBindings(
  config: KeymapConfig,
  context?: KeymapContext,
): Readonly<KeymapBindings> {
  if (context === undefined) return config.bindings;
  return config.contexts?.[context] ?? {};
}

/** What a scope's changes lie over: the defaults, or the global keymap. */
function scopeBase(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  context: KeymapContext | undefined,
): Map<string, string> {
  const defaults = defaultBindings(commands);
  if (context === undefined) return defaults;
  return layBindings(defaults, config.bindings, config.macros);
}

/** The config with one scope's bindings replaced; an empty context goes. */
function withScope(
  config: KeymapConfig,
  context: KeymapContext | undefined,
  bindings: KeymapBindings,
): KeymapConfig {
  if (context === undefined) return { ...config, bindings };
  const contexts = { ...config.contexts, [context]: bindings };
  if (Object.keys(bindings).length === 0) delete contexts[context];
  return { ...config, contexts };
}

export type KeySource = "default" | "user" | "removed";

export type BoundKey = Readonly<{
  sequence: string;
  source: KeySource;
  /** Added or struck in this context only, not everywhere. */
  scope?: KeymapContext;
}>;

/**
 * One row of Settings › Keybindings: a command's keys, the ones a person
 * added, and the defaults they took away (drawn struck through, so a default
 * is never hidden).
 */
export function keysFor(
  target: string,
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  context?: KeymapContext,
): BoundKey[] {
  if (context !== undefined)
    return scopedKeys(target, config, commands, context);
  const defaults = defaultBindings(commands);
  const keys: BoundKey[] = [];
  for (const [sequence, id] of defaults) {
    if (id !== target) continue;
    const override = config.bindings[sequence];
    keys.push({
      sequence,
      source: override === undefined ? "default" : "removed",
    });
  }
  for (const [sequence, id] of Object.entries(config.bindings)) {
    if (id === target) keys.push({ sequence, source: "user" });
  }
  return keys;
}

/**
 * A command's keys as they hold in one context: the global keys that context
 * leaves alone, the ones it strikes or hands to something else (struck, and
 * scoped), and the ones it adds (scoped).
 */
function scopedKeys(
  target: string,
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  context: KeymapContext,
): BoundKey[] {
  const overlay = scopeBindings(config, context);
  const keys: BoundKey[] = [];
  for (const key of keysFor(target, config, commands)) {
    if (overlay[key.sequence] === undefined) keys.push(key);
    else if (key.source !== "removed")
      keys.push({ sequence: key.sequence, source: "removed", scope: context });
  }
  for (const [sequence, id] of Object.entries(overlay)) {
    if (id === target) keys.push({ sequence, source: "user", scope: context });
  }
  return keys;
}

/** Changed everywhere, or — with a context — changed in that context. */
export function isChanged(
  target: string,
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  context?: KeymapContext,
): boolean {
  return keysFor(target, config, commands, context).some((key) =>
    context === undefined ? key.source !== "default" : key.scope === context,
  );
}

export type Conflict =
  | { kind: "none" }
  /** The sequence already runs something else. */
  | { kind: "taken"; target: string }
  /** It shares a prefix with other keys: the shorter waits for the timeout. */
  | { kind: "prefix"; with: readonly string[] };

export function conflictFor(
  sequence: string,
  target: string,
  bindings: ReadonlyMap<string, string>,
): Conflict {
  const current = bindings.get(sequence);
  if (current !== undefined && current !== target)
    return { kind: "taken", target: current };
  const overlapping = [...bindings.keys()].filter(
    (other) =>
      other !== sequence &&
      (other.startsWith(`${sequence} `) || sequence.startsWith(`${other} `)),
  );
  return overlapping.length > 0
    ? { kind: "prefix", with: overlapping }
    : { kind: "none" };
}

/** Sequences that start one another — each makes the shorter wait. */
export function prefixClashes(
  bindings: ReadonlyMap<string, string>,
): Set<string> {
  const clashes = new Set<string>();
  const sequences = [...bindings.keys()];
  for (const shorter of sequences) {
    for (const longer of sequences) {
      if (longer.startsWith(`${shorter} `)) {
        clashes.add(shorter);
        clashes.add(longer);
      }
    }
  }
  return clashes;
}

/** Put `sequence` on the config as `target`, spelling it sparsely. */
function put(
  bindings: KeymapBindings,
  defaults: ReadonlyMap<string, string>,
  sequence: string,
  target: string,
): void {
  if (defaults.get(sequence) === target) delete bindings[sequence];
  else if (target === NOP && !defaults.has(sequence)) delete bindings[sequence];
  else bindings[sequence] = target;
}

export type BindMode =
  /** Take the key: whatever had it loses it. */
  | "replace"
  /** Trade: whatever had the key takes `previous` in exchange. */
  | "swap";

/** `previous`: the keycap being re-recorded; `context`: where it applies. */
export type BindOptions = Readonly<{
  previous?: string;
  mode?: BindMode;
  context?: KeymapContext;
}>;

/**
 * Bind `sequence` to `target`. `previous` is the key being re-recorded (the
 * keycap the person picked), which is released — and, on a swap, handed to
 * whatever held `sequence`.
 */
export function bindKey(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  sequence: string,
  target: string,
  options: BindOptions = {},
): KeymapConfig {
  const { previous, mode = "replace", context } = options;
  const base = scopeBase(config, commands, context);
  const bindings = { ...scopeBindings(config, context) };
  const holder = effectiveBindings(config, commands, context).get(sequence);
  if (previous !== undefined && previous !== sequence) {
    const handTo = mode === "swap" && holder !== undefined ? holder : NOP;
    put(bindings, base, previous, handTo);
  }
  put(bindings, base, sequence, target);
  return withScope(config, context, bindings);
}

/**
 * Take a key away from whatever holds it — everywhere, or in one context
 * only. A default is struck, not lost.
 */
export function unbindKey(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  sequence: string,
  context?: KeymapContext,
): KeymapConfig {
  const bindings = { ...scopeBindings(config, context) };
  put(bindings, scopeBase(config, commands, context), sequence, NOP);
  return withScope(config, context, bindings);
}

/**
 * Forget what a scope says about `sequence`: a struck default comes back to
 * its command, and a key the person bound there is let go.
 */
export function restoreKey(
  config: KeymapConfig,
  sequence: string,
  context?: KeymapContext,
): KeymapConfig {
  const bindings = { ...scopeBindings(config, context) };
  delete bindings[sequence];
  return withScope(config, context, bindings);
}

/**
 * Every change a person made to one command's keys in one scope, undone:
 * the keys they gave it, and the keys of its own they struck or handed to
 * something else, which come back (and the other command loses them).
 */
export function resetTarget(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  target: string,
  context?: KeymapContext,
): KeymapConfig {
  const base = scopeBase(config, commands, context);
  const bindings: KeymapBindings = {};
  for (const [sequence, id] of Object.entries(scopeBindings(config, context))) {
    const takenFrom = base.get(sequence) === target;
    if (id !== target && !takenFrom) bindings[sequence] = id;
  }
  return withScope(config, context, bindings);
}

/**
 * Every key bound to `from`, in every scope, moved to `to` — or, with null,
 * let go (a renamed or deleted macro).
 */
export function retargetKeys(
  config: KeymapConfig,
  from: string,
  to: string | null,
): KeymapConfig {
  const move = (layer: Readonly<KeymapBindings>): KeymapBindings => {
    const next: KeymapBindings = {};
    for (const [sequence, target] of Object.entries(layer)) {
      if (target !== from) next[sequence] = target;
      else if (to !== null) next[sequence] = to;
    }
    return next;
  };
  let next: KeymapConfig = withScope(config, undefined, move(config.bindings));
  for (const context of KEYMAP_CONTEXTS) {
    const layer = config.contexts?.[context];
    if (layer) next = withScope(next, context, move(layer));
  }
  return next;
}

/** The label a target is drawn with: the command's, or the macro's name. */
export function targetLabel(
  target: string,
  commands: readonly KeymapCommand[],
): string {
  if (target.startsWith(MACRO_PREFIX)) return `@${macroName(target)}`;
  return commandById(target, commands)?.label ?? target;
}

export function targetKind(
  target: string,
  commands: readonly KeymapCommand[],
): CommandKind {
  if (target === NOP) return "nop";
  if (target.startsWith(MACRO_PREFIX)) return "draft";
  return commandById(target, commands)?.kind ?? "navigate";
}
