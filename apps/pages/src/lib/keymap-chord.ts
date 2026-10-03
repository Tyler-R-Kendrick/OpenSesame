/**
 * The keyboard's half-typed state (ADR 0155): a count, a sequence prefix,
 * and vim's registers — `q` or `@` waiting for a letter, a recording on.
 * The handler in `keymap.ts` reads and writes it; `showPending` tells the
 * statusline after every press (vim's `showcmd`).
 */
import {
  REGISTER_PREFIX,
  RESERVED_KEYS,
} from "@opensesame/app-core/lib/keymap/commands.js";
import type { KeymapContext } from "@opensesame/app-core/lib/keymap/context.js";
import { tokenFromPress } from "@opensesame/app-core/lib/keymap/notation.js";
import type { CommandRun } from "./keymap-commands.js";
import { publishPending } from "./keymap-pending.js";
import {
  type RegisterState,
  answerRegister,
  beginRegister,
  createRegisterState,
} from "./keymap-registers.js";

/** A half-typed count or sequence, held apart from the handler that reads it. */
export type ChordState = {
  count: number;
  /** Tokens typed so far of a longer sequence: `g` of `g v`. */
  pending: string[];
  /** The listing the press that last extended `pending` landed in. */
  context: KeymapContext | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** vim's registers: `q` or `@` waiting for a letter, a recording on. */
  registers: RegisterState;
};

export function createChordState(): ChordState {
  return {
    count: 0,
    pending: [],
    context: null,
    timer: undefined,
    registers: createRegisterState(),
  };
}

export function clearPending(chord: ChordState): void {
  chord.pending = [];
  chord.context = null;
  chord.registers.awaiting = null;
  clearTimeout(chord.timer);
  chord.timer = undefined;
}

/** Whether some binding in `map` is longer than `sequence` and starts with it. */
export function continues(
  map: ReadonlyMap<string, string>,
  sequence: string,
): boolean {
  const prefix = `${sequence} `;
  for (const key of map.keys()) if (key.startsWith(prefix)) return true;
  return false;
}

/**
 * A held key repeats. A register key or a sequence is one deliberate press, so
 * an auto-repeat of `q` must not toggle a recording on and off, nor a held
 * `g` finish `g g`: the repeat is swallowed and nothing moves. A motion held
 * down (`j`) keeps repeating.
 */
export function repeatIgnored(
  event: KeyboardEvent,
  chord: ChordState,
  map: ReadonlyMap<string, string>,
): boolean {
  if (!event.repeat) return false;
  const token = tokenFromPress(event);
  if (token === null || keepsItsMeaning(event, token)) return false;
  const half = chord.registers.awaiting !== null || chord.pending.length > 0;
  const target = map.get(token);
  return (
    half ||
    continues(map, token) ||
    (target?.startsWith(REGISTER_PREFIX) ?? false)
  );
}

/** Tell the statusline what is half-typed: vim's `showcmd`. */
export function showPending(chord: ChordState): void {
  const { awaiting, recording, announcement } = chord.registers;
  const waitingCount = awaiting && awaiting.steps > 1 ? awaiting.steps : 0;
  publishPending({
    count: awaiting ? waitingCount : chord.count,
    keys: awaiting?.keys ?? chord.pending,
    context:
      awaiting === null && chord.pending.length > 0 ? chord.context : null,
    awaiting: awaiting?.kind ?? null,
    recording: recording?.register ?? null,
    announcement,
  });
}

/**
 * A register key ran: `q` stops a recording, or the key waits for its
 * letter as long as a half-typed sequence would.
 */
export function startRegister(
  chord: ChordState,
  command: string,
  keys: readonly string[],
  steps: number,
  timeoutMs: number,
): void {
  if (!beginRegister(chord.registers, command, keys, steps)) return;
  clearTimeout(chord.timer);
  chord.timer = setTimeout(() => {
    clearPending(chord);
    showPending(chord);
  }, timeoutMs);
}

/** Keys that keep their meaning after `q` or `@`, and cancel the wait. */
const PASS_THROUGH = new Set(["Escape", "F6", "Enter"]);

/**
 * A fixed key (Tab, Shift+Tab, Enter, Shift+Enter, Escape, F6, Shift+F10, the
 * Menu key) or a key the browser keeps is never a register name and is never
 * swallowed by the wait: it cancels the wait and does its own work. The count
 * digits are reserved too, but a digit there is just an invalid name.
 */
function keepsItsMeaning(event: KeyboardEvent, token: string): boolean {
  if (PASS_THROUGH.has(event.key)) return true;
  return RESERVED_KEYS.has(token) && !/^\d$/.test(token);
}

/**
 * The key after `q` or `@` names the register; true when this press was it.
 * A bare Shift on the way to `@` keeps waiting.
 */
export function registerKey(
  event: KeyboardEvent,
  chord: ChordState,
  run: Omit<CommandRun, "event" | "steps" | "hadCount">,
): boolean {
  if (chord.registers.awaiting === null) return false;
  const token = tokenFromPress(event);
  if (token === null) return true;
  if (keepsItsMeaning(event, token)) {
    clearPending(chord);
    return false;
  }
  clearTimeout(chord.timer);
  chord.timer = undefined;
  answerRegister(chord.registers, token, { ...run, event });
  event.preventDefault();
  return true;
}
