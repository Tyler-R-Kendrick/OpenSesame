/**
 * The `?` sheet drawn from the keys in force (ADR 0150), not from the
 * defaults with a person's overrides appended: a row whose commands still
 * hold their default keys reads as authored; one a person changed is rebuilt
 * from the effective bindings, one line per command, with the keys that moved
 * on the command that now owns them; one whose commands lost every key is
 * dropped. Their keys for commands the sheet has no row for follow, and
 * context-scoped keys say where they hold.
 */
import {
  type KeymapCommand,
  NOP,
  SECTION_PREFIX,
  commandById,
} from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapConfig } from "@opensesame/app-core/lib/keymap/config.js";
import {
  CONTEXT_LABEL,
  KEYMAP_CONTEXTS,
  type KeymapContext,
} from "@opensesame/app-core/lib/keymap/context.js";
import {
  defaultBindings,
  effectiveBindings,
  targetLabel,
} from "@opensesame/app-core/lib/keymap/effective.js";
import {
  keycapLabel,
  parseSequence,
} from "@opensesame/app-core/lib/keymap/notation.js";
import type { HelpSource, KeymapHelpRow } from "./keymap-help-sources.js";

/** The keymap a sheet is drawn from: what is bound, and what can be. */
export type KeymapView = Readonly<{
  config: KeymapConfig;
  commands: readonly KeymapCommand[];
}>;

/** A sequence as its keycaps read: `g v` is `g v`, `Control+d` is `Ctrl-d`. */
export function said(sequence: string): string {
  return (parseSequence(sequence) ?? [sequence]).map(keycapLabel).join(" ");
}

type KeysOf = (id: string) => readonly string[];

function keysIn(map: ReadonlyMap<string, string>): KeysOf {
  return (id) => [...map].filter(([, target]) => target === id).map(([s]) => s);
}

const COUNTS = [3, 10];

/** `3j  10k`: a count before the first key of each command, where it is one press. */
function countedKeys(source: HelpSource, keysOf: KeysOf): string {
  return source.commands
    .map((id, at) => {
      const first = keysOf(id)[0];
      const press = first === undefined ? null : parseSequence(first);
      return press?.length === 1
        ? `${COUNTS[at] ?? 1}${said(first ?? "")}`
        : "";
    })
    .filter(Boolean)
    .join("  ");
}

/**
 * A changed row: one line per command that still has a key, then its fixed
 * key — which stays even when every command lost its keys, because Enter and
 * Esc are not the person's to take away.
 */
function rebuilt(
  source: HelpSource,
  keysOf: KeysOf,
  commands: readonly KeymapCommand[],
): KeymapHelpRow[] {
  if (source.counted) {
    const keys = countedKeys(source, keysOf);
    return keys === "" ? [] : [[keys, source.action]];
  }
  const rows: KeymapHelpRow[] = [];
  for (const id of source.commands) {
    const keys = keysOf(id);
    if (keys.length === 0) continue;
    rows.push([
      keys.map(said).join(" / "),
      commandById(id, commands)?.label ?? id,
    ]);
  }
  if (source.fixed) rows.push(source.fixed);
  return rows;
}

/** The authored rows, each kept as authored or rebuilt from the keys in force. */
export function effectiveRows(
  sources: readonly HelpSource[],
  { config, commands }: KeymapView,
): KeymapHelpRow[] {
  const keysOf = keysIn(effectiveBindings(config, commands));
  const defaultKeysOf = keysIn(defaultBindings(commands));
  const unchanged = (id: string) => {
    const now = keysOf(id);
    const was = defaultKeysOf(id);
    return now.length === was.length && now.every((key) => was.includes(key));
  };
  return sources.flatMap((source) =>
    source.commands.every(unchanged)
      ? [[source.keys, source.action] as const]
      : rebuilt(source, keysOf, commands),
  );
}

/** Jump keys still on a section: `g s` handed to something else is no longer one. */
export function liveJumpKeys(
  jumpKeys: readonly string[],
  { config, commands }: KeymapView,
): readonly string[] {
  const map = effectiveBindings(config, commands);
  return jumpKeys.filter((key) =>
    map.get(`g ${key}`)?.startsWith(SECTION_PREFIX),
  );
}

function yourRow(
  commands: readonly KeymapCommand[],
  sequence: string,
  target: string,
  context?: KeymapContext,
): KeymapHelpRow {
  const where = context ? CONTEXT_LABEL[context] : null;
  const action =
    target === NOP
      ? ["unbound", where]
      : [
          `${targetLabel(target, commands)} (yours${where ? `, ${where}` : ""})`,
        ];
  return [said(sequence), action.filter(Boolean).join(" ")];
}

/**
 * A person's own keys the authored rows do not already show: everywhere
 * first, then each listing's (ADR 0150 §6), each saying where it holds. A
 * global key on a command the sheet has a row for, or an unbind of one, is in
 * that row already.
 */
export function yourRows(
  { config, commands }: KeymapView,
  covered: ReadonlySet<string>,
): KeymapHelpRow[] {
  const defaults = defaultBindings(commands);
  const shown = (sequence: string, target: string) => {
    const held = target === NOP ? defaults.get(sequence) : target;
    if (held === undefined) return false;
    if (target === NOP)
      return covered.has(held) || held.startsWith(SECTION_PREFIX);
    return covered.has(held);
  };
  const global = Object.entries(config.bindings)
    .filter(([sequence, target]) => !shown(sequence, target))
    .map(([sequence, target]) => yourRow(commands, sequence, target));
  const scoped = KEYMAP_CONTEXTS.flatMap((context) =>
    Object.entries(config.contexts?.[context] ?? {}).map(([sequence, target]) =>
      yourRow(commands, sequence, target, context),
    ),
  );
  return [...global, ...scoped];
}
