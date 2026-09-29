/**
 * Macros (ADR 0150 §4): named step lists, each step a command and a count,
 * and the closed set of events one may run on. Read from boundary data and
 * refused whole, like the rest of the keymap.
 */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type CommandKind,
  type KeymapCommand,
  MACRO_PREFIX,
  REGISTER_PREFIX,
  SECTION_PREFIX,
  commandById,
} from "./commands.js";

export type MacroStep = Readonly<{ command: string; count: number }>;

/**
 * `unlock` fires once when the vault opens; `enter:<section>` each time that
 * section becomes the page. A closed set: vim's autocmd, without a language.
 */
export type KeymapEvent = "unlock" | `enter:${string}`;

export type Macro = Readonly<{
  steps: readonly MacroStep[];
  on?: KeymapEvent;
}>;

/**
 * `runs` caps what one press may do: a count typed before a macro's key
 * repeats it, and `999` in front of a 32-step macro of 99-times steps must
 * not become three million commands (or a hundred thousand vault writes).
 */
export const MACRO_LIMITS = {
  steps: 32,
  count: 99,
  macros: 64,
  runs: 1_000,
} as const;

const MACRO_NAME = /^[a-z][a-z0-9-]{0,23}$/;

export function isMacroTarget(target: string): boolean {
  return target.startsWith(MACRO_PREFIX);
}

export function macroName(target: string): string {
  return target.slice(MACRO_PREFIX.length);
}

/**
 * A macro by its own name. A plain object answers `constructor`, `toString`
 * and `__proto__` too, and none of those is a macro.
 */
export function ownMacro(
  macros: Readonly<Record<string, Macro>>,
  name: string,
): Macro | undefined {
  return Object.hasOwn(macros, name) ? macros[name] : undefined;
}

/** A step written `3 listing.next` or `listing.next`. */
export function parseStep(written: string): MacroStep | null {
  const match = /^\s*(?:(\d{1,2})\s*[x×*]?\s+)?([a-z][\w.-]*)\s*$/i.exec(
    written,
  );
  if (!match?.[2]) return null;
  const count = match[1] ? Number(match[1]) : 1;
  return { command: match[2], count };
}

export function formatStep(step: MacroStep): string {
  return step.count > 1 ? `${step.count} ${step.command}` : step.command;
}

export type Refusal = { ok: false; message: string };
export type Read<T> = { ok: true; value: T } | Refusal;

export function refuse(message: string): Refusal {
  return { ok: false, message };
}

export function accept<T>(value: T): Read<T> {
  return { ok: true, value };
}

function countProblem(step: MacroStep): string | null {
  if (!Number.isInteger(step.count) || step.count < 1)
    return `${step.command}: a count is 1 or more.`;
  if (step.count > MACRO_LIMITS.count)
    return `${step.command}: at most ${MACRO_LIMITS.count} times.`;
  return null;
}

/** What a step's kind of command allows, given the macro's trigger. */
function kindProblem(
  step: MacroStep,
  kind: CommandKind,
  on: KeymapEvent | undefined,
): string | null {
  if (kind === "nop") return "nop does nothing in a macro.";
  if (kind === "authority")
    return `${step.command} asks before it acts; a macro cannot run it.`;
  if (on !== undefined && kind !== "navigate")
    return `${step.command} runs only from a key, never from an event.`;
  if (on?.startsWith("enter:") && step.command.startsWith(SECTION_PREFIX))
    return "A macro run on entering a section cannot jump to another.";
  return null;
}

/** Why `step` may not run in a macro with this trigger, or null. */
export function stepProblem(
  step: MacroStep,
  on: KeymapEvent | undefined,
  commands: readonly KeymapCommand[],
): string | null {
  const count = countProblem(step);
  if (count) return count;
  if (step.command.startsWith(REGISTER_PREFIX))
    return "A macro cannot record or replay a register.";
  if (isMacroTarget(step.command)) return "A macro cannot run another macro.";
  const command = commandById(step.command, commands);
  if (command === undefined && !step.command.startsWith(SECTION_PREFIX))
    return `Unknown command "${step.command}".`;
  return kindProblem(step, command?.kind ?? "navigate", on);
}

function validEvent(on: string): on is KeymapEvent {
  return on === "unlock" || /^enter:[a-z][a-z0-9-]*$/.test(on);
}

/** A macro's `on:`, or a refusal. Absent, null and blank all mean "keys only". */
function readTrigger(
  name: string,
  raw: BoundaryValue | undefined,
): Read<KeymapEvent | undefined> {
  if (raw === undefined || raw === null || raw === "") return accept(undefined);
  if (!isString(raw) || !validEvent(raw))
    return refuse(`Macro "${name}": "${String(raw)}" is not an event.`);
  return accept(raw);
}

function readSteps(
  name: string,
  raw: BoundaryValue | undefined,
  on: KeymapEvent | undefined,
  commands: readonly KeymapCommand[],
): Read<MacroStep[]> {
  if (!Array.isArray(raw) || raw.length === 0)
    return refuse(`Macro "${name}" has no steps.`);
  if (raw.length > MACRO_LIMITS.steps)
    return refuse(`Macro "${name}": at most ${MACRO_LIMITS.steps} steps.`);
  const steps: MacroStep[] = [];
  for (const written of raw) {
    const step = isString(written) ? parseStep(written) : null;
    if (step === null)
      return refuse(`Macro "${name}": "${String(written)}" is not a step.`);
    const problem = stepProblem(step, on, commands);
    if (problem) return refuse(`Macro "${name}": ${problem}`);
    steps.push(step);
  }
  return accept(steps);
}

function readMacro(
  name: string,
  raw: BoundaryValue,
  commands: readonly KeymapCommand[],
): Read<Macro> {
  if (!MACRO_NAME.test(name))
    return refuse(
      `Macro "${name}": a name is lowercase letters, digits and dashes.`,
    );
  const body: BoundaryValue = Array.isArray(raw) ? { steps: raw } : raw;
  if (!isJsonObject(body)) return refuse(`Macro "${name}" has no steps.`);
  const trigger = readTrigger(name, body.on);
  if (!trigger.ok) return trigger;
  const on = trigger.value;
  const steps = readSteps(name, body.steps, on, commands);
  if (!steps.ok) return steps;
  return accept(
    on === undefined ? { steps: steps.value } : { steps: steps.value, on },
  );
}

export function readMacros(
  raw: BoundaryValue,
  commands: readonly KeymapCommand[],
): Read<Record<string, Macro>> {
  if (!isJsonObject(raw))
    return refuse("macros is a mapping of names to steps.");
  const names = Object.keys(raw);
  if (names.length > MACRO_LIMITS.macros)
    return refuse(`At most ${MACRO_LIMITS.macros} macros.`);
  // No prototype: no name a person writes can resolve to an inherited member.
  const macros: Record<string, Macro> = Object.create(null);
  for (const name of names) {
    const macro = readMacro(name, raw[name] ?? null, commands);
    if (!macro.ok) return macro;
    macros[name] = macro.value;
  }
  return accept(macros);
}

/** A macro as data: its trigger, if any, and its steps written out. */
export type MacroJson = { on?: KeymapEvent; steps: string[] };

export function macroJson(macro: Macro): MacroJson {
  const json: MacroJson = { steps: macro.steps.map(formatStep) };
  if (macro.on) json.on = macro.on;
  return json;
}

/** `enter:vault` — the event of opening a section. */
export function enterEvent(section: string): KeymapEvent {
  return `enter:${section}`;
}
