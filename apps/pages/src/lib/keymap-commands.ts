/**
 * What each keymap command does (ADR 0156). The catalogue in app-core names
 * the commands and their default keys; this is the shell's half — the one
 * place a command id turns into a motion, a pane, a verb or a jump. The key
 * handler, a macro and an event trigger all run commands through here, so a
 * macro can only ever do what a key already could.
 */

import { JOIN_COMMAND_PATH } from "@opensesame/app-core/lib/command-bar/types.js";
import {
  type KeymapCommand,
  MACRO_PREFIX,
  SECTION_PREFIX,
  commandById,
  keymapCommands,
} from "@opensesame/app-core/lib/keymap/commands.js";
import {
  MACRO_LIMITS,
  type Macro,
  type MacroStep,
} from "@opensesame/app-core/lib/keymap/config.js";
import { loadKeymap } from "@opensesame/app-core/lib/keymap/store.js";
import { focusCommandBar, toggleCommandBarMic } from "./command-bar/focus.js";
import { sectionCommandPath } from "./keymap-jumps.js";
import {
  type ListingMotion,
  type Origin,
  currentRailTarget,
  currentSearchTarget,
  currentVaultTarget,
  listingOf,
  movementTarget,
} from "./keymap-targets.js";

export type CommandRun = Readonly<{
  /**
   * The key press, a gesture's first touch, or a blank event for a trigger:
   * it says which listing.
   */
  event: Origin;
  steps: number;
  hadCount: boolean;
  navigate: (path: string) => void;
  showHelp: () => void;
  /**
   * Run by an event trigger, not a key. A trigger has no press to say which
   * listing it means, so its motions move the vault list and nothing else.
   */
  trigger?: boolean;
}>;

function times(n: number, run: () => void): void {
  for (let i = 0; i < n; i++) run();
}

export function goToCount(target: ListingMotion | null, n: number): void {
  if (!target) return;
  if (target.toIndex) {
    target.toIndex(Math.max(0, n - 1));
    return;
  }
  target.first();
  if (n > 1) target.next(n - 1);
}

type Motion = (listing: ListingMotion | null, run: CommandRun) => void;

/**
 * A motion lands on the listing the key was pressed in, and otherwise brings
 * the keyboard to the one it moves first — the tree keeps the cursor it drew.
 */
const MOTIONS: ReadonlyMap<string, Motion> = new Map<string, Motion>([
  ["listing.next", (listing, { steps }) => listing?.next(steps)],
  ["listing.previous", (listing, { steps }) => listing?.previous(steps)],
  [
    "listing.first",
    (listing, { steps, hadCount }) =>
      hadCount ? goToCount(listing, steps) : listing?.first(),
  ],
  [
    "listing.last",
    (listing, { steps, hadCount }) =>
      hadCount ? goToCount(listing, steps) : listing?.last(),
  ],
  ["listing.high", (listing) => listing?.edge?.("high")],
  ["listing.mid", (listing) => listing?.edge?.("mid")],
  ["listing.low", (listing) => listing?.edge?.("low")],
  [
    "listing.half-down",
    (listing, { steps }) => times(steps, () => listing?.page?.(1, "half")),
  ],
  [
    "listing.half-up",
    (listing, { steps }) => times(steps, () => listing?.page?.(-1, "half")),
  ],
  [
    "listing.page-down",
    (listing, { steps }) => times(steps, () => listing?.page?.(1, "full")),
  ],
  [
    "listing.page-up",
    (listing, { steps }) => times(steps, () => listing?.page?.(-1, "full")),
  ],
  [
    "listing.dive",
    (listing, { steps }) => times(steps, () => listing?.enter()),
  ],
  [
    "listing.climb",
    (listing, { steps }) => times(steps, () => listing?.parent()),
  ],
]);

const VERBS: ReadonlyMap<string, (run: CommandRun) => void> = new Map<
  string,
  (run: CommandRun) => void
>([
  [
    "listing.search",
    () => (currentSearchTarget() ?? currentVaultTarget())?.search(),
  ],
  ["command.palette", () => focusCommandBar()],
  ["help.keymap", ({ showHelp }) => showHelp()],
  ["voice.toggle", () => toggleCommandBarMic()],
  ["item.copy-secret", () => currentVaultTarget()?.copySecret()],
  ["item.copy-username", () => currentVaultTarget()?.copyUsername()],
  ["item.edit", () => currentVaultTarget()?.edit()],
  ["item.new", () => currentVaultTarget()?.create()],
  ["item.favorite", () => currentVaultTarget()?.favorite()],
  ["item.trash", () => currentVaultTarget()?.trash()],
  ["item.share", () => currentVaultTarget()?.share()],
  ["session.join", ({ navigate }) => navigate(JOIN_COMMAND_PATH)],
  ["item.restore", () => currentVaultTarget()?.restore?.()],
  ["item.purge", () => currentVaultTarget()?.purge?.()],
]);

/** Whether `id` moves a cursor: a motion keeps its meaning after a prefix. */
export function isMotion(id: string): boolean {
  return MOTIONS.has(id);
}

function jump(id: string, { navigate }: CommandRun): void {
  const path = sectionCommandPath(id);
  if (path === null) return;
  const rail = currentRailTarget();
  if (rail?.goTo) {
    rail.goTo(path);
    rail.focus?.();
  } else navigate(path);
}

/** What a trigger may not do even in the vault list: change the tree's level. */
const TRIGGER_BARRED = new Set(["listing.dive", "listing.climb"]);

function runMotion(id: string, motion: Motion, run: CommandRun): void {
  if (run.trigger) {
    // Never the rail (its motions navigate, so two triggers could hand the
    // route back and forth), and never a change of level.
    if (TRIGGER_BARRED.has(id)) return;
    const vault = currentVaultTarget();
    vault?.focus?.();
    motion(vault, run);
    return;
  }
  const listing = movementTarget(run.event);
  if (!listingOf(run.event)) listing?.focus?.();
  motion(listing, run);
}

/** Run one command. Unknown or unbound ids do nothing. */
export function runCommand(id: string, run: CommandRun): void {
  const motion = MOTIONS.get(id);
  if (motion) {
    runMotion(id, motion, run);
    return;
  }
  const verb = VERBS.get(id);
  if (verb) {
    verb(run);
    return;
  }
  if (id.startsWith(SECTION_PREFIX)) jump(id, run);
}

/**
 * Run a macro's steps in order. A step's count is a count prefix when the
 * command takes one (`3 listing.next` is `3j`) and a repeat otherwise; a count
 * typed before the macro's own key repeats the whole macro (`3@q`).
 */
export function runMacro(macro: Macro, run: CommandRun): number {
  // A value that came from a name a person wrote may not be a macro at all.
  if (!Array.isArray(macro?.steps)) return 0;
  const commands = keymapCommands();
  let budget = MACRO_LIMITS.runs;
  // The shell's counts reach 999; the run budget is the cap, and it also
  // stops a macro of several steps part-way through a round.
  const rounds = Math.min(run.steps, MACRO_LIMITS.runs);
  for (let round = 0; round < rounds && budget > 0; round++) {
    for (const step of macro.steps) {
      budget -= runStep(step, run, budget, commands);
    }
  }
  return MACRO_LIMITS.runs - budget;
}

/**
 * One macro step, at most `budget` primitive commands of it; returns what it
 * spent. A counted command (`99 listing.dive`) runs its count in one call,
 * so it is charged that count: the limit is on what the keys could reach,
 * not on how many calls the shell makes.
 */
function runStep(
  step: MacroStep,
  run: CommandRun,
  budget: number,
  commands: readonly KeymapCommand[],
): number {
  if (budget <= 0 || step.command.startsWith(MACRO_PREFIX)) return 0;
  const command = commandById(step.command, commands);
  if (command?.kind === "authority") return 0;
  const count = Math.min(step.count, budget);
  if (command?.counts) {
    runCommand(step.command, { ...run, steps: count, hadCount: count > 1 });
  } else {
    times(count, () =>
      runCommand(step.command, { ...run, steps: 1, hadCount: false }),
    );
  }
  return count;
}

/**
 * The macro `name` names, when the keymap holds one by that name: an own
 * entry only, so `constructor` or `toString` is never mistaken for one.
 */
export function ownMacro(name: string): Macro | undefined {
  const macros = loadKeymap().macros;
  return Object.hasOwn(macros, name) ? macros[name] : undefined;
}

/** Run whatever a binding names: a command, or `macro.<name>`. */
export function runTarget(target: string, run: CommandRun): void {
  if (target.startsWith(MACRO_PREFIX)) {
    const macro = ownMacro(target.slice(MACRO_PREFIX.length));
    if (macro) runMacro(macro, run);
    return;
  }
  runCommand(target, run);
}
