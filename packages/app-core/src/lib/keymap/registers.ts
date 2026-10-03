/**
 * Registers (ADR 0156): vim's `q{a–z}` records what the keys ran into a
 * macro named `q-<letter>`, and `@{a–z}` replays it. A recording is an
 * ordinary macro once it is kept, so the Macros panel lists it, a key may be
 * bound to it, and every guardrail on a macro holds for it.
 */
import { MACRO_PREFIX, REGISTER_PREFIX } from "./commands.js";
import {
  type KeymapConfig,
  MACRO_LIMITS,
  type Macro,
  type MacroStep,
} from "./config.js";

/** The macro a register is kept as: `q-a`. */
export function registerMacroName(register: string): string {
  return `q-${register}`;
}

/** The register a token names, or null: one of `a`–`z`. */
export function registerOf(token: string): string | null {
  return /^[a-z]$/.test(token) ? token : null;
}

export function isRegisterCommand(id: string): boolean {
  return id.startsWith(REGISTER_PREFIX);
}

/** A count on these picks a row (`5G`): two runs are not one run of two. */
const ROW_PICKERS = new Set(["listing.first", "listing.last"]);

/**
 * Add one run to a recording. A run of the same command straight after
 * folds into the step before it (`j j j` is `3 listing.next`) when that
 * means the same thing; the recording stops growing at the macro limit.
 */
export function appendRecorded(
  steps: readonly MacroStep[],
  step: MacroStep,
): MacroStep[] {
  const count = Math.min(Math.max(1, step.count), MACRO_LIMITS.count);
  const last = steps.at(-1);
  if (
    last?.command === step.command &&
    !ROW_PICKERS.has(step.command) &&
    last.count + count <= MACRO_LIMITS.count
  ) {
    return [
      ...steps.slice(0, -1),
      { command: step.command, count: last.count + count },
    ];
  }
  if (steps.length >= MACRO_LIMITS.steps) return [...steps];
  return [...steps, { command: step.command, count }];
}

/** A macro's steps as a recording sees them: `count` runs, in order. */
export function appendMacroRun(
  steps: readonly MacroStep[],
  macro: Macro,
  count: number,
): MacroStep[] {
  let next = [...steps];
  // The shell's run budget is on primitive commands, not on runs: a macro of
  // 99 commands replays ten times, not a thousand. Write as many runs as the
  // shell would reach, and at least the one that was pressed.
  const perRun = macro.steps.reduce(
    (sum, step) =>
      step.command.startsWith(MACRO_PREFIX) ? sum : sum + step.count,
    0,
  );
  const reach =
    perRun === 0 ? MACRO_LIMITS.runs : Math.floor(MACRO_LIMITS.runs / perRun);
  const runs = Math.min(Math.max(1, count), Math.max(1, reach));
  for (let run = 0; run < runs; run++) {
    for (const step of macro.steps) next = appendRecorded(next, step);
  }
  return next;
}

/**
 * The keymap with a recording kept in its register, replacing an older one.
 * An empty recording keeps nothing: null.
 */
export function withRecording(
  config: KeymapConfig,
  register: string,
  steps: readonly MacroStep[],
): KeymapConfig | null {
  if (steps.length === 0) return null;
  return {
    ...config,
    macros: { ...config.macros, [registerMacroName(register)]: { steps } },
  };
}
