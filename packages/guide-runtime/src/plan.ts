/**
 * The step plan: a GuideLang program read the way a person walks it.
 *
 * The language is a flat list of instructions, and a person does not
 * experience a flat list. They experience *steps*: a sentence to read, or a
 * control to look at, optionally with something to do. `planGuideSteps` groups
 * instructions into those steps once, as a pure function of the program, so
 * the runtime and any presentation agree on what "step 3 of 6" means without
 * either of them parsing prose or counting directives.
 *
 * A *beat* is one thing on screen. It begins at a presenting directive —
 * `say`, `focus`, `hint` or `annotate`, or the closing `success` — and owns the
 * `wait` that directly follows it, if there is one: "point at this, then wait
 * until they have done it" is one step with a "your move" in it.
 * Everything between two beats that is not presenting — `navigate`, `scroll`
 * and the waits that make the destination ready — is the *preamble* of the
 * beat that comes next: it runs by itself on the way in, never as a step of
 * its own, so a tour never asks a person to press Next to change screens.
 *
 * Every plan ends in exactly one `close` beat. A program that ends with
 * `success` closes on that text; any other program closes on a synthetic beat
 * with no message, so a tour always has a place to stop that is not a cliff.
 */

import type {
  AnnotateInstruction,
  FocusInstruction,
  GuideGoalId,
  GuideInstruction,
  GuideProgram,
  GuideRouteId,
  GuideSide,
  GuideTargetId,
  HintInstruction,
  SayInstruction,
  SuccessInstruction,
  WaitInstruction,
} from "@opensesame/guide-lang";

type PointingInstruction =
  | FocusInstruction
  | HintInstruction
  | AnnotateInstruction;
type PresentingInstruction =
  | PointingInstruction
  | SayInstruction
  | SuccessInstruction;

export type GuideBeatKind = "narrate" | "point" | "close";

export type GuideBeat = {
  /** Zero-based position in `plan.beats`. */
  readonly ordinal: number;
  readonly kind: GuideBeatKind;
  /** The directive that draws this beat, or -1 for a synthetic close. */
  readonly present: number;
  /** First instruction of the preamble (equal to `present` when there is none). */
  readonly start: number;
  /** Exclusive end: the preamble and the beat's own trailing wait are inside. */
  readonly end: number;
  readonly message: string | null;
  readonly target: GuideTargetId | null;
  readonly side: GuideSide | null;
  readonly pointer: "focus" | "hint" | "annotate" | null;
  /**
   * What the program waits for straight after presenting this beat. When it
   * is not already true as the beat is drawn, the person can satisfy the beat
   * by making it so; Next still advances either way.
   */
  readonly until: WaitInstruction | null;
  /** The last `navigate` at or before this beat, for Back to restore. */
  readonly route: GuideRouteId | null;
};

export type GuidePlan = {
  readonly goal: GuideGoalId;
  readonly beats: readonly GuideBeat[];
  /** Beats a person counts ("step 3 of N"): every beat but the closing one. */
  readonly stepCount: number;
};

function isPointing(
  instruction: GuideInstruction,
): instruction is PointingInstruction {
  return (
    instruction.kind === "focus" ||
    instruction.kind === "hint" ||
    instruction.kind === "annotate"
  );
}

function isPresenting(
  instruction: GuideInstruction,
): instruction is PresentingInstruction {
  return (
    isPointing(instruction) ||
    instruction.kind === "say" ||
    instruction.kind === "success"
  );
}

export function planGuideSteps(program: GuideProgram): GuidePlan {
  const instructions = program.instructions;
  const beats: GuideBeat[] = [];
  let preamble = 0;
  let route: GuideRouteId | null = null;

  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (instruction === undefined) continue;
    if (instruction.kind === "navigate") route = instruction.route;
    if (!isPresenting(instruction)) continue;

    let end = index + 1;
    let until: WaitInstruction | null = null;
    const following = instructions[end];
    if (instruction.kind !== "success" && following?.kind === "wait") {
      until = following;
      end += 1;
    }
    const kind: GuideBeatKind =
      instruction.kind === "success"
        ? "close"
        : isPointing(instruction)
          ? "point"
          : "narrate";
    beats.push({
      ordinal: beats.length,
      kind,
      present: index,
      start: preamble,
      end,
      message: instruction.message,
      target: isPointing(instruction) ? instruction.target : null,
      side: isPointing(instruction) ? instruction.side : null,
      pointer: isPointing(instruction) ? instruction.kind : null,
      until,
      route,
    });
    preamble = end;
    index = end - 1;
  }

  // A `success` is only a close when nothing presents after it; the parser
  // permits a mid-program `success`, which is then an ordinary narrate beat.
  const last = beats.at(-1);
  const fixed = beats.map((beat, position) =>
    beat.kind === "close" && position !== beats.length - 1
      ? { ...beat, kind: "narrate" as const }
      : beat,
  );
  if (last?.kind !== "close") {
    fixed.push({
      ordinal: fixed.length,
      kind: "close",
      present: -1,
      start: preamble,
      end: instructions.length,
      message: null,
      target: null,
      side: null,
      pointer: null,
      until: null,
      route,
    });
  }
  return {
    goal: program.goal,
    beats: fixed,
    stepCount: fixed.length - 1,
  };
}
