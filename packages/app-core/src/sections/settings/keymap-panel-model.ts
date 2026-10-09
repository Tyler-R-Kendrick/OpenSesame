/**
 * View-model for Settings › Keybindings (ADR 0156, ADR 0133 §8): the rows the
 * Keymap panel draws, the filters over them, and the macro recorder that turns
 * key presses back into steps. No React, no DOM.
 */
import {
  GROUP_LABEL,
  GROUP_ORDER,
  type KeymapCommand,
  MACRO_PREFIX,
  NOP,
  commandById,
} from "../../lib/keymap/commands.js";
import type { KeymapConfig, MacroStep } from "../../lib/keymap/config.js";
import {
  CONTEXT_LABEL,
  KEYMAP_CONTEXTS,
  type KeymapContext,
} from "../../lib/keymap/context.js";
import {
  type BoundKey,
  characterSequence,
  effectiveBindings,
  isChanged,
  keysFor,
  prefixClashes,
} from "../../lib/keymap/effective.js";
import {
  appendRecorded,
  isRegisterCommand,
} from "../../lib/keymap/registers.js";

/** VS Code's "modified", "no keybinding" and a view of the waiting keys. */
export type KeymapFilter = "all" | "changed" | "unbound" | "waits";

export const KEYMAP_FILTERS: readonly { id: KeymapFilter; label: string }[] = [
  { id: "all", label: "every command" },
  { id: "changed", label: "changed" },
  { id: "unbound", label: "no key" },
  { id: "waits", label: "shared prefix" },
];

/** Where the table's keys apply: everywhere, or one listing (ADR 0156 §6). */
export type KeymapScope = "everywhere" | KeymapContext;

export const KEYMAP_SCOPES: readonly { id: KeymapScope; label: string }[] = [
  { id: "everywhere", label: "everywhere" },
  ...KEYMAP_CONTEXTS.map((id) => ({ id, label: CONTEXT_LABEL[id] })),
];

/** The context a scope names, or none for "everywhere". */
export function scopeContext(scope: KeymapScope): KeymapContext | undefined {
  return scope === "everywhere" ? undefined : scope;
}

export type KeyCell = BoundKey & {
  /** It starts, or is started by, another binding: the shorter one waits. */
  waits: boolean;
  /** A character key while character keys are switched off (WCAG 2.1.4). */
  off?: boolean;
};

export type KeymapRow = Readonly<{
  command: KeymapCommand;
  keys: readonly KeyCell[];
  changed: boolean;
  /** Asks before it acts: no key may be moved onto it (ADR 0156). */
  locked: boolean;
}>;

export type KeymapGroup = Readonly<{
  id: string;
  label: string;
  rows: readonly KeymapRow[];
}>;

function matchesQuery(command: KeymapCommand, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return (
    command.label.toLowerCase().includes(needle) ||
    command.id.toLowerCase().includes(needle)
  );
}

/** A recorded sequence finds every binding it is, or begins. */
function matchesKeys(row: KeymapRow, recorded: string): boolean {
  return row.keys.some(
    (key) =>
      key.source !== "removed" &&
      (key.sequence === recorded || key.sequence.startsWith(`${recorded} `)),
  );
}

function matchesFilter(row: KeymapRow, filter: KeymapFilter): boolean {
  if (filter === "changed") return row.changed;
  if (filter === "unbound")
    return !row.keys.some((key) => key.source !== "removed");
  if (filter === "waits") return row.keys.some((key) => key.waits);
  return true;
}

export function keymapRow(
  command: KeymapCommand,
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  waiting: ReadonlySet<string>,
  context?: KeymapContext,
): KeymapRow {
  return {
    command,
    keys: keysFor(command.id, config, commands, context).map((key) => ({
      ...key,
      waits: key.source !== "removed" && waiting.has(key.sequence),
      off: !config.singleKeys && characterSequence(key.sequence),
    })),
    changed: isChanged(command.id, config, commands, context),
    locked: command.kind === "authority",
  };
}

export type KeymapView = {
  query?: string;
  recorded?: string | null;
  filter?: KeymapFilter;
  /** The scope whose keys the rows show. */
  scope?: KeymapScope;
};

/** The Keymap panel's groups, filtered by words, by keys and by state. */
export function keymapGroups(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
  options: KeymapView,
): KeymapGroup[] {
  const { query = "", recorded = null, filter = "all" } = options;
  const context = scopeContext(options.scope ?? "everywhere");
  const waiting = prefixClashes(
    effectiveBindings({ ...config, singleKeys: true }, commands, context),
  );
  return GROUP_ORDER.map((group) => ({
    id: group,
    label: GROUP_LABEL[group],
    rows: commands
      .filter((command) => command.group === group)
      .map((command) => keymapRow(command, config, commands, waiting, context))
      .filter(
        (row) =>
          matchesQuery(row.command, query) &&
          (recorded === null ||
            recorded === "" ||
            matchesKeys(row, recorded)) &&
          matchesFilter(row, filter),
      ),
  })).filter((group) => group.rows.length > 0);
}

/** Every layer a person wrote: the global one, then each context's. */
function layers(config: KeymapConfig) {
  return [
    { scope: undefined, bindings: config.bindings },
    ...KEYMAP_CONTEXTS.map((context) => ({
      scope: context,
      bindings: config.contexts?.[context] ?? {},
    })),
  ];
}

/** How many commands a person has changed, anywhere, for the panel's count. */
export function changedCount(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
): number {
  const targets = new Set<string>();
  for (const { bindings } of layers(config)) {
    for (const [sequence, target] of Object.entries(bindings)) {
      targets.add(target);
      if (target !== NOP) continue;
      const holder = commands.find((command) =>
        command.defaults.includes(sequence),
      );
      if (holder) targets.add(holder.id);
    }
  }
  targets.delete(NOP);
  return [...targets].filter((target) => !target.startsWith(MACRO_PREFIX))
    .length;
}

/** A person's binding to a command this plan does not have. */
export type UnavailableBinding = Readonly<{
  sequence: string;
  target: string;
  scope?: KeymapContext;
}>;

/**
 * Bindings kept for a command the catalogue does not list right now — a
 * section jump whose capability left the plan. `readKeymap` keeps them so
 * they come back with it; the panel lists them so they are never invisible.
 */
export function unavailableBindings(
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
): UnavailableBinding[] {
  const known = new Set(commands.map((command) => command.id));
  const found: UnavailableBinding[] = [];
  for (const { scope, bindings } of layers(config)) {
    for (const [sequence, target] of Object.entries(bindings)) {
      if (target === NOP || target.startsWith(MACRO_PREFIX)) continue;
      if (known.has(target)) continue;
      found.push(scope ? { sequence, target, scope } : { sequence, target });
    }
  }
  return found;
}

export type Recording = Readonly<{
  steps: readonly MacroStep[];
  /** Keys that ran nothing a macro may run (unbound, a trash, a macro). */
  skipped: readonly string[];
}>;

/**
 * Turn recorded key presses into macro steps, reading them exactly as the
 * shell would: counts first, then sequences against the keymap in force.
 * Anything a macro may not run is left out and reported.
 */
export function stepsFromKeys(
  tokens: readonly string[],
  config: KeymapConfig,
  commands: readonly KeymapCommand[],
): Recording {
  const bindings = effectiveBindings(config, commands);
  // `j j j` records as `3 listing.next`, the way a person would write it,
  // and exactly as the shell's own recording (`q`) folds it.
  let steps: MacroStep[] = [];
  const skipped: string[] = [];
  let count = 0;
  let pending: string[] = [];

  const emit = (target: string, sequence: string) => {
    const kind = commandById(target, commands)?.kind;
    if (
      target.startsWith(MACRO_PREFIX) ||
      isRegisterCommand(target) ||
      kind === "authority"
    ) {
      skipped.push(sequence);
    } else steps = appendRecorded(steps, { command: target, count });
    count = 0;
  };

  const continues = (sequence: string) =>
    [...bindings.keys()].some((key) => key.startsWith(`${sequence} `));

  /** The `move` group is the shell's motions (pinned by a drift test). */
  const isMotionTarget = (target: string) =>
    commandById(target, commands)?.group === "move";

  // The shell's `resolveToken`: a key that continues nothing after a prefix
  // swallows the prefix. A character key goes with it, unless it is a motion,
  // which keeps its meaning (`g k` is `k`); a named key is read afresh.
  const resolve = (token: string): void => {
    const prefix = pending;
    let sequence = [...prefix, token].join(" ");
    // The shell's `sequenceOf`: `g V` reads as `g v` after a prefix.
    if (
      prefix.length > 0 &&
      !bindings.has(sequence) &&
      !continues(sequence) &&
      /^[A-Z]$/.test(token)
    ) {
      sequence = [...prefix, token.toLowerCase()].join(" ");
    }
    if (continues(sequence)) {
      pending = sequence.split(" ");
      return;
    }
    pending = [];
    const target = bindings.get(sequence);
    if (target !== undefined) {
      emit(target, sequence);
      return;
    }
    const fresh = bindings.get(token);
    const swallowed =
      prefix.length === 0 ||
      (token.length === 1 && !(fresh !== undefined && isMotionTarget(fresh)));
    if (swallowed) {
      skipped.push(sequence);
      count = 0;
      return;
    }
    skipped.push(prefix.join(" "));
    resolve(token);
  };

  for (const token of tokens) {
    // The shell's `countKey` runs before any prefix is read, so a digit is
    // a count even while a prefix is pending (`g 3 k` is `3 listing.previous`).
    if (/^[1-9]$/.test(token)) {
      count = Math.min(count * 10 + Number(token), 99);
      continue;
    }
    if (token === "0" && count > 0) {
      count = Math.min(count * 10, 99);
      continue;
    }
    resolve(token);
  }
  if (pending.length > 0) {
    const sequence = pending.join(" ");
    const target = bindings.get(sequence);
    if (target !== undefined) emit(target, sequence);
    else skipped.push(sequence);
  }
  return { steps, skipped };
}
