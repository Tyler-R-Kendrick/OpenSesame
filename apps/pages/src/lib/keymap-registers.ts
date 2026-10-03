/**
 * Live macro recording in the shell (ADR 0150): vim's `q{a–z}` … `q` and
 * `@{a–z}` / `@@`. The handler hands every command it runs to `recordRun`
 * while a recording is on; the register keys wait for their letter here.
 *
 * A recording keeps what the keys ran, with the counts they ran with. It
 * leaves out the register keys themselves and every command that asks
 * before it acts (trash, share): those still run, they are just never
 * written into a macro, so a replay can never trash or share.
 */
import {
  MACRO_PREFIX,
  REGISTER_RECORD,
  commandById,
} from "@opensesame/app-core/lib/keymap/commands.js";
import type { MacroStep } from "@opensesame/app-core/lib/keymap/config.js";
import {
  appendMacroRun,
  appendRecorded,
  isRegisterCommand,
  registerMacroName,
  registerOf,
  withRecording,
} from "@opensesame/app-core/lib/keymap/registers.js";
import {
  loadKeymap,
  saveKeymap,
} from "@opensesame/app-core/lib/keymap/store.js";
import { type CommandRun, ownMacro, runMacro } from "./keymap-commands.js";

export type RegisterState = {
  /** `q` or `@` pressed, waiting for its letter; `steps` is the count before it. */
  awaiting: {
    kind: "record" | "replay";
    steps: number;
    keys: readonly string[];
  } | null;
  recording: { register: string; steps: MacroStep[] } | null;
  /** What `@@` replays. */
  lastReplayed: string | null;
  announcement: string;
};

export function createRegisterState(): RegisterState {
  return {
    awaiting: null,
    recording: null,
    lastReplayed: null,
    announcement: "",
  };
}

function stopRecording(state: RegisterState): void {
  const recording = state.recording;
  if (recording === null) return;
  const next = withRecording(loadKeymap(), recording.register, recording.steps);
  // An empty recording is nothing; one with steps storage refused is not.
  if (next === null) {
    state.recording = null;
    state.announcement = `nothing recorded in @${recording.register}`;
    return;
  }
  const saved = saveKeymap(next);
  // A refused save keeps the recording, so the person can free some room
  // and press `q` again; it ends only once something has taken it.
  if (!saved.ok) {
    state.announcement = `@${recording.register} not kept: ${saved.message}`;
    return;
  }
  state.recording = null;
  state.announcement = `recorded @${recording.register}`;
}

/**
 * A register key ran. `q` during a recording stops it; otherwise the key
 * waits for its letter. Returns whether it now waits.
 */
export function beginRegister(
  state: RegisterState,
  command: string,
  keys: readonly string[],
  steps: number,
): boolean {
  if (command === REGISTER_RECORD && state.recording !== null) {
    stopRecording(state);
    return false;
  }
  const kind = command === REGISTER_RECORD ? "record" : "replay";
  state.awaiting = { kind, steps, keys };
  return true;
}

function replay(
  state: RegisterState,
  register: string,
  steps: number,
  run: Omit<CommandRun, "steps" | "hadCount">,
): void {
  state.lastReplayed = register;
  const macro = ownMacro(registerMacroName(register));
  if (!macro) return;
  runMacro(macro, { ...run, steps, hadCount: steps > 1 });
  if (state.recording) {
    state.recording.steps = appendMacroRun(state.recording.steps, macro, steps);
  }
}

/**
 * The key after `q` or `@`: a letter a–z names the register, `@` after `@`
 * is the last one replayed, and anything else cancels quietly.
 */
export function answerRegister(
  state: RegisterState,
  token: string,
  run: Omit<CommandRun, "steps" | "hadCount">,
): void {
  const awaiting = state.awaiting;
  state.awaiting = null;
  if (awaiting === null) return;
  if (awaiting.kind === "record") {
    const register = registerOf(token);
    if (register === null) return;
    state.recording = { register, steps: [] };
    state.announcement = `recording @${register}`;
    return;
  }
  const register = token === "@" ? state.lastReplayed : registerOf(token);
  if (register !== null) replay(state, register, awaiting.steps, run);
}

/** Write one command the handler ran into the recording, if one is on. */
export function recordRun(
  state: RegisterState,
  target: string,
  steps: number,
): void {
  const recording = state.recording;
  if (recording === null || isRegisterCommand(target)) return;
  if (target.startsWith(MACRO_PREFIX)) {
    const macro = ownMacro(target.slice(MACRO_PREFIX.length));
    if (macro) recording.steps = appendMacroRun(recording.steps, macro, steps);
    return;
  }
  const command = commandById(target);
  if (command?.kind === "authority") return;
  // A count on a command that takes none ran it once, and replays once.
  recording.steps = appendRecorded(recording.steps, {
    command: target,
    count: command?.counts ? steps : 1,
  });
}
