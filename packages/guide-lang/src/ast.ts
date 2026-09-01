/**
 * GuideLang v1 — the abstract syntax a support model may emit.
 *
 * The language is intentionally far less expressive than JavaScript. There is
 * no click, no type, no submit, no fetch, no selector and no escape hatch:
 * a guide may *show* a person where something is and *wait* for them to do it.
 * That missing power is the security property — a prompt-injected model cannot
 * ask for an operation the grammar has no way to express.
 */

import type {
  GuideGoalId,
  GuidePredicateId,
  GuideRouteId,
  GuideTargetId,
} from "./ids.js";

export const GUIDE_LANG_VERSION = 1;
export const GUIDE_LANG_HEADER = "guide/1";

export type GuideSide = "top" | "right" | "bottom" | "left";
export const GUIDE_SIDES: readonly GuideSide[] = [
  "top",
  "right",
  "bottom",
  "left",
];

export type GuideWaitEvent = "activate" | "appear" | "disappear";
export const GUIDE_WAIT_EVENTS: readonly GuideWaitEvent[] = [
  "activate",
  "appear",
  "disappear",
];

/** Every directive name the parser accepts. Anything else fails closed. */
export const GUIDE_INSTRUCTION_NAMES = [
  "say",
  "focus",
  "hint",
  "annotate",
  "scroll",
  "navigate",
  "wait",
  "success",
  "pause",
  "end",
] as const;

export type GuideInstructionName = (typeof GUIDE_INSTRUCTION_NAMES)[number];

export type SayInstruction = {
  readonly kind: "say";
  readonly message: string;
};

export type FocusInstruction = {
  readonly kind: "focus";
  readonly target: GuideTargetId;
  readonly message: string;
  readonly side: GuideSide | null;
};

export type HintInstruction = {
  readonly kind: "hint";
  readonly target: GuideTargetId;
  readonly message: string;
  readonly side: GuideSide | null;
};

export type AnnotateInstruction = {
  readonly kind: "annotate";
  readonly target: GuideTargetId;
  readonly message: string;
  readonly side: GuideSide | null;
};

export type ScrollInstruction = {
  readonly kind: "scroll";
  readonly target: GuideTargetId;
};

export type NavigateInstruction = {
  readonly kind: "navigate";
  readonly route: GuideRouteId;
};

export type WaitTargetInstruction = {
  readonly kind: "wait";
  readonly subject: "target";
  readonly target: GuideTargetId;
  readonly event: GuideWaitEvent;
  readonly timeoutMs: number;
};

export type WaitRouteInstruction = {
  readonly kind: "wait";
  readonly subject: "route";
  readonly route: GuideRouteId;
  readonly timeoutMs: number;
};

export type WaitStateInstruction = {
  readonly kind: "wait";
  readonly subject: "state";
  readonly predicate: GuidePredicateId;
  readonly expected: boolean;
  readonly timeoutMs: number;
};

export type WaitInstruction =
  | WaitTargetInstruction
  | WaitRouteInstruction
  | WaitStateInstruction;

export type SuccessInstruction = {
  readonly kind: "success";
  readonly message: string;
};

export type PauseInstruction = { readonly kind: "pause" };

export type EndInstruction = { readonly kind: "end" };

export type GuideInstruction =
  | SayInstruction
  | FocusInstruction
  | HintInstruction
  | AnnotateInstruction
  | ScrollInstruction
  | NavigateInstruction
  | WaitInstruction
  | SuccessInstruction
  | PauseInstruction
  | EndInstruction;

export type GuideProgram = {
  readonly version: typeof GUIDE_LANG_VERSION;
  readonly goal: GuideGoalId;
  readonly instructions: readonly GuideInstruction[];
};

/**
 * Safety budgets. The parser enforces these, and `@opensesame/guide-runtime`
 * enforces them again independently — a runtime that trusted the parser would
 * be one refactor away from executing an 800-step trajectory.
 *
 * `maxInstructions` is 8 because a trajectory is meant to run to the next
 * observation boundary and then replan, not to describe a whole tour up front.
 */
export const GUIDE_LIMITS = {
  /** Instructions after the header and goal. */
  maxInstructions: 8,
  /** Characters of model-authored text in any one directive. */
  maxMessageChars: 500,
  /** UTF-8 bytes of the whole payload. */
  maxProgramBytes: 8192,
  /** Physical lines, blank ones included. */
  maxLines: 32,
  minTimeoutMs: 250,
  maxTimeoutMs: 60_000,
  /** Only ever one guide on screen at a time. */
  maxConcurrentGuides: 1,
} as const;

/**
 * Characters rejected outright in model-authored text: C0/C1 controls carry no
 * meaning in a popover, and the bidi and zero-width ranges are how a reviewer
 * reading a transcript gets shown something other than what will render.
 */
const FORBIDDEN_TEXT_CHARACTERS =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the C0/C1 ranges are the point — this pattern exists to keep them out of rendered guide text.
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/u;

/**
 * Message length in code points, which is what a person means by "characters".
 *
 * Exported because the parser and the runtime both enforce `maxMessageChars`
 * and have to agree: counting UTF-16 units in one of them made a 300-emoji
 * `say` pass the compiler and then fail the runtime, since every astral
 * character counts twice.
 */
export function countGuideTextCharacters(value: string): number {
  return Array.from(value).length;
}

/** True when model-authored text carries a character the renderer must not see. */
export function hasForbiddenTextCharacter(value: string): boolean {
  return FORBIDDEN_TEXT_CHARACTERS.test(value);
}

export function isGuideSide(value: string): value is GuideSide {
  return GUIDE_SIDES.some((side) => side === value);
}

export function isGuideWaitEvent(value: string): value is GuideWaitEvent {
  return GUIDE_WAIT_EVENTS.some((event) => event === value);
}

export function isGuideInstructionName(
  value: string,
): value is GuideInstructionName {
  return GUIDE_INSTRUCTION_NAMES.some((name) => name === value);
}

/** `pause` and `end` stop progression, so nothing may follow them. */
export function isTerminalInstruction(instruction: GuideInstruction): boolean {
  return instruction.kind === "pause" || instruction.kind === "end";
}
