/**
 * Reading a keymap back from storage (ADR 0150). A panel or a file is refused
 * whole, so a person is told and nothing is half-applied. What was stored is
 * different: it was valid when it was written, and a later build may retire a
 * command or tighten a rule. One entry that no longer passes must not take the
 * person's other keys and macros with it, so each entry is judged alone and
 * only the offenders are dropped.
 */
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
} from "@opensesame/os-domain";
import { type KeymapCommand, keymapCommands } from "./commands.js";
import {
  EMPTY_KEYMAP,
  type KeymapConfig,
  macroJson,
  readKeymap,
} from "./config.js";
import { KEYMAP_CONTEXTS } from "./context.js";
import { defaultBindings } from "./effective.js";
import { MACRO_LIMITS, readMacros } from "./macros.js";

type Pair = readonly [string, BoundaryValue];

function pairsOf(raw: BoundaryValue | undefined): Pair[] {
  return raw !== undefined && isJsonObject(raw) ? Object.entries(raw) : [];
}

/** Everything a lone entry is judged with. */
type Judge = Readonly<{
  commands: readonly KeymapCommand[];
  defaults: ReadonlyMap<string, string>;
}>;

function passes(candidate: BoundaryValue, judge: Judge): boolean {
  return readKeymap(candidate, judge.commands, judge.defaults).ok;
}

function keepMacros(raw: BoundaryValue | undefined, judge: Judge): Pair[] {
  const kept: Pair[] = [];
  for (const [name, body] of pairsOf(raw)) {
    if (kept.length >= MACRO_LIMITS.macros) break;
    if (readMacros({ [name]: body }, judge.commands).ok)
      kept.push([name, body]);
  }
  return kept;
}

function keepBindings(
  raw: BoundaryValue | undefined,
  macros: BoundaryValue,
  judge: Judge,
): Pair[] {
  return pairsOf(raw).filter(([key, target]) =>
    passes({ macros, bindings: { [key]: target } }, judge),
  );
}

/** Each context's own entries that pass, as `[name, entries]` for the read. */
function keepContexts(
  raw: BoundaryValue | undefined,
  macros: BoundaryValue,
  bindings: BoundaryValue,
  judge: Judge,
): Pair[] {
  const kept: Pair[] = [];
  for (const [name, layer] of pairsOf(raw)) {
    const entries = pairsOf(layer).filter(([key, target]) =>
      passes(
        { macros, bindings, contexts: { [name]: { [key]: target } } },
        judge,
      ),
    );
    if (entries.length > 0) kept.push([name, Object.fromEntries(entries)]);
  }
  return kept;
}

/**
 * The stored keymap with every entry that still passes: the whole of it when
 * nothing is refused, and otherwise what is left after the offenders go.
 */
export function salvageKeymap(candidate: BoundaryValue): KeymapConfig {
  const commands = keymapCommands();
  const judge = { commands, defaults: defaultBindings(commands) };
  const whole = readKeymap(candidate, commands, judge.defaults);
  if (whole.ok) return whole.config;
  if (!isJsonObject(candidate)) return EMPTY_KEYMAP;
  const macros = Object.fromEntries(keepMacros(candidate.macros, judge));
  const bindings = Object.fromEntries(
    keepBindings(candidate.bindings ?? candidate.keybindings, macros, judge),
  );
  const contexts = Object.fromEntries(
    keepContexts(candidate.contexts, macros, bindings, judge),
  );
  const flag = candidate.singleKeys;
  const singleKeys = flag !== undefined && isBoolean(flag) ? flag : true;
  const kept = readKeymap(
    { macros, bindings, contexts, singleKeys },
    commands,
    judge.defaults,
  );
  return kept.ok ? kept.config : EMPTY_KEYMAP;
}

function sortedPairs<T>(record: Readonly<Record<string, T>>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) =>
    left.localeCompare(right),
  );
}

/** The keymap as canonical JSON: the same keys and macros, whatever the order. */
export function keymapFingerprint(config: KeymapConfig): string {
  return JSON.stringify([
    config.singleKeys,
    sortedPairs(config.bindings),
    sortedPairs(config.macros).map(([name, macro]) => [name, macroJson(macro)]),
    KEYMAP_CONTEXTS.map((context) => [
      context,
      sortedPairs(config.contexts?.[context] ?? {}),
    ]),
  ]);
}
