/**
 * A person's keymap (ADR 0156): the bindings they changed and the macros they
 * wrote. It is sparse on purpose — defaults are never copied into it — so the
 * file says exactly what is theirs, and a later default reaches them unless
 * they chose otherwise.
 */
import {
  type BoundaryObject,
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type KeymapCommand,
  NOP,
  RESERVED_KEYS,
  SECTION_PREFIX,
  commandById,
} from "./commands.js";
import {
  type KeymapContext,
  type KeymapContexts,
  isKeymapContext,
} from "./context.js";
import {
  type GestureBindings,
  gestureBindingProblem,
  gestureById,
  gestureNameProblem,
  isGestureId,
} from "./gestures.js";
import {
  type Macro,
  type MacroJson,
  type Read,
  accept,
  isMacroTarget,
  macroJson,
  macroName,
  ownMacro,
  readMacros,
  refuse,
} from "./macros.js";
import { canonicalSequence, parseSequence } from "./notation.js";

export {
  type KeymapEvent,
  MACRO_LIMITS,
  type Macro,
  type MacroJson,
  type MacroStep,
  enterEvent,
  formatStep,
  isMacroTarget,
  macroJson,
  macroName,
  ownMacro,
  parseStep,
  stepProblem,
} from "./macros.js";

/** Sequence → command id, `macro.<name>`, or `nop` to unbind a default. */
export type KeymapBindings = Record<string, string>;

export type KeymapConfig = Readonly<{
  bindings: Readonly<KeymapBindings>;
  macros: Readonly<Record<string, Macro>>;
  /** WCAG 2.1.4: single printed-character keys can be switched off. */
  singleKeys: boolean;
  /**
   * Keys laid over `bindings` only while the keyboard is in one listing
   * (ADR 0156 §6). Absent reads as none.
   */
  contexts?: KeymapContexts;
  /**
   * The touch loadout (ADR 0168): gesture → command, sparse against the
   * catalogue's defaults. Absent reads as none.
   */
  gestures?: Readonly<GestureBindings>;
  /** WCAG 2.5.4: gestures made by moving the phone can be switched off. */
  motion?: boolean;
}>;

export const EMPTY_KEYMAP: KeymapConfig = {
  bindings: {},
  macros: {},
  singleKeys: true,
};

const UNSAFE_TARGET = /^(https?:|javascript:|data:|\/\/)|:\/\//i;

export type KeymapResult =
  | { ok: true; config: KeymapConfig }
  | { ok: false; message: string };

/** Why a sequence cannot be bound, or null when it can. */
export function reservedReason(sequence: string): string | null {
  const tokens = parseSequence(sequence);
  if (tokens === null) return `"${sequence}" is not a key.`;
  for (const token of tokens) {
    const reason = RESERVED_KEYS.get(token);
    if (reason !== undefined) return `${token} is fixed: ${reason}.`;
  }
  return null;
}

/**
 * Whether `target` asks before it acts and `sequence` is not its own locked
 * default: such a command may only keep the keys it ships with.
 */
export function authorityLocked(
  sequence: string,
  target: string,
  commands: readonly KeymapCommand[],
  defaults: ReadonlyMap<string, string>,
): boolean {
  return (
    commandById(target, commands)?.kind === "authority" &&
    defaults.get(sequence) !== target
  );
}

/** Why `target` may not be bound to `sequence`, or null. */
export function bindingProblem(
  sequence: string,
  target: string,
  commands: readonly KeymapCommand[],
  macros: Readonly<Record<string, Macro>>,
  defaults: ReadonlyMap<string, string>,
): string | null {
  const reserved = reservedReason(sequence);
  if (reserved) return reserved;
  if (UNSAFE_TARGET.test(target))
    return "Keybindings cannot name URLs or endpoints.";
  if (target === NOP) return null;
  if (isMacroTarget(target)) {
    return ownMacro(macros, macroName(target)) === undefined
      ? `No macro "${macroName(target)}".`
      : null;
  }
  const command = commandById(target, commands);
  // A jump whose capability left the plan stays in the file, unbound until
  // it comes back.
  if (command === undefined && !target.startsWith(SECTION_PREFIX))
    return `Unknown action "${target}".`;
  if (authorityLocked(sequence, target, commands, defaults))
    return `Action "${target}" requires confirmation and cannot be rebound to skip it.`;
  return null;
}

/** What a layer of bindings is checked and kept sparse against. */
type BindingRules = Readonly<{
  commands: readonly KeymapCommand[];
  macros: Readonly<Record<string, Macro>>;
  /** The catalogue's defaults: what a locked command may keep. */
  defaults: ReadonlyMap<string, string>;
  /** What this layer is laid over: the defaults, or the global keymap. */
  base: ReadonlyMap<string, string>;
}>;

function readBindings(
  raw: BoundaryValue,
  rules: BindingRules,
): Read<KeymapBindings> {
  if (!isJsonObject(raw))
    return refuse("Keybindings must be a mapping of keys to action ids.");
  const { commands, macros, defaults, base } = rules;
  const bindings: KeymapBindings = {};
  for (const [written, target] of Object.entries(raw)) {
    const sequence = canonicalSequence(written);
    if (sequence === null) return refuse(`"${written}" is not a key.`);
    const value = target === null ? NOP : target;
    if (!isString(value))
      return refuse(`Binding for "${written}" is not an action id.`);
    const problem = bindingProblem(sequence, value, commands, macros, defaults);
    if (problem) return refuse(problem);
    // Restating what is already there is not a change: the file keeps only
    // what is theirs.
    if (base.get(sequence) === value) continue;
    if (value === NOP && !base.has(sequence)) continue;
    bindings[sequence] = value;
  }
  return accept(bindings);
}

/** Lay one layer of bindings over `map`: `nop` strikes, a lost macro too. */
export function layBindings(
  map: Map<string, string>,
  bindings: Readonly<KeymapBindings>,
  macros: Readonly<Record<string, Macro>>,
): Map<string, string> {
  for (const [sequence, target] of Object.entries(bindings)) {
    if (target === NOP) map.delete(sequence);
    else if (
      isMacroTarget(target) &&
      ownMacro(macros, macroName(target)) === undefined
    )
      map.delete(sequence);
    else map.set(sequence, target);
  }
  return map;
}

/** `contexts:`, each read like `keybindings:` over the global keymap. */
function readContexts(
  raw: BoundaryValue | undefined,
  rules: BindingRules,
): Read<KeymapContexts> {
  if (raw === undefined || raw === null) return accept({});
  if (!isJsonObject(raw))
    return refuse("contexts is a mapping of vault and rail to keybindings.");
  const contexts: Partial<Record<KeymapContext, KeymapBindings>> = {};
  for (const [name, layer] of Object.entries(raw)) {
    if (!isKeymapContext(name))
      return refuse(`"${name}" is not a context: vault or rail.`);
    const read = readBindings(layer ?? {}, rules);
    if (!read.ok) return refuse(`In ${name}: ${read.message}`);
    if (Object.keys(read.value).length > 0) contexts[name] = read.value;
  }
  return accept(contexts);
}

/** `gestures:`, each name a gesture and each value what it runs. */
function readGestures(
  raw: BoundaryValue | undefined,
  commands: readonly KeymapCommand[],
  macros: Readonly<Record<string, Macro>>,
): Read<GestureBindings> {
  if (raw === undefined || raw === null) return accept({});
  if (!isJsonObject(raw))
    return refuse("gestures is a mapping of gestures to action ids.");
  const gestures: GestureBindings = {};
  for (const [name, target] of Object.entries(raw)) {
    if (!isGestureId(name))
      return refuse(gestureNameProblem(name) ?? `"${name}" is not a gesture.`);
    const value = target === null ? NOP : target;
    if (!isString(value))
      return refuse(`Gesture "${name}" is not an action id.`);
    const problem = gestureBindingProblem(value, commands, macros);
    if (problem) return refuse(problem);
    const shipped = gestureById(name)?.default;
    // Restating the default is not a change; striking a gesture is.
    if (value === shipped) continue;
    gestures[name] = value;
  }
  return accept(gestures);
}

/** The touch loadout: the gestures a person changed, and the motion switch. */
function readTouch(
  candidate: BoundaryObject,
  commands: readonly KeymapCommand[],
  macros: Readonly<Record<string, Macro>>,
): Read<{ gestures: GestureBindings; motion: boolean }> {
  const gestures = readGestures(candidate.gestures, commands, macros);
  if (!gestures.ok) return gestures;
  const motion = candidate.motion ?? true;
  if (!isBoolean(motion)) return refuse("motion must be true or false.");
  return accept({ gestures: gestures.value, motion });
}

/**
 * Decode a keymap from boundary data (the stored JSON, or the parsed file).
 * Every problem is refused whole: a keymap is never half-applied.
 */
export function readKeymap(
  candidate: BoundaryValue,
  commands: readonly KeymapCommand[],
  defaults: ReadonlyMap<string, string>,
): KeymapResult {
  if (!isJsonObject(candidate)) return refuse("A keymap is a mapping.");
  const macros = readMacros(candidate.macros ?? {}, commands);
  if (!macros.ok) return macros;
  const rules = { commands, macros: macros.value, defaults, base: defaults };
  const bindings = readBindings(
    candidate.bindings ?? candidate.keybindings ?? {},
    rules,
  );
  if (!bindings.ok) return bindings;
  const global = layBindings(new Map(defaults), bindings.value, macros.value);
  const contexts = readContexts(candidate.contexts, { ...rules, base: global });
  if (!contexts.ok) return contexts;
  const singleKeys = candidate.singleKeys ?? true;
  if (!isBoolean(singleKeys))
    return refuse("singleKeys must be true or false.");
  const touch = readTouch(candidate, commands, macros.value);
  if (!touch.ok) return touch;
  let config: KeymapConfig = {
    bindings: bindings.value,
    macros: macros.value,
    singleKeys,
  };
  if (hasContexts(contexts.value))
    config = { ...config, contexts: contexts.value };
  if (Object.keys(touch.value.gestures).length > 0)
    config = { ...config, gestures: touch.value.gestures };
  if (!touch.value.motion) config = { ...config, motion: false };
  return { ok: true, config };
}

/** Whether any context holds a key. */
export function hasContexts(contexts: KeymapContexts | undefined): boolean {
  return Object.values(contexts ?? {}).some(
    (layer) => Object.keys(layer).length > 0,
  );
}

/** The keymap as plain JSON, as storage and the file hold it. */
export type KeymapJson = {
  bindings: KeymapBindings;
  macros: Record<string, MacroJson>;
  singleKeys: boolean;
  contexts?: Partial<Record<KeymapContext, KeymapBindings>>;
  gestures?: GestureBindings;
  motion?: boolean;
};

/**
 * The keymap as plain JSON, for storage. A context appears once it has keys,
 * the gestures once one is changed, and `motion` once it is off.
 */
export function keymapJson(config: KeymapConfig): KeymapJson {
  const json: KeymapJson = {
    bindings: { ...config.bindings },
    macros: Object.fromEntries(
      Object.entries(config.macros).map(([name, macro]) => [
        name,
        macroJson(macro),
      ]),
    ),
    singleKeys: config.singleKeys,
  };
  if (hasContexts(config.contexts)) {
    const contexts: Partial<Record<KeymapContext, KeymapBindings>> = {};
    for (const [name, layer] of Object.entries(config.contexts ?? {})) {
      if (isKeymapContext(name) && Object.keys(layer).length > 0)
        contexts[name] = { ...layer };
    }
    json.contexts = contexts;
  }
  if (Object.keys(config.gestures ?? {}).length > 0)
    json.gestures = { ...config.gestures };
  if (config.motion === false) json.motion = false;
  return json;
}
