/**
 * Semantic validation against the vocabulary the *application* declares.
 *
 * Syntax proves a string cannot be a selector, a URL or a script. It cannot
 * prove that `nav.connections` is a control this build actually has — only the
 * live registries know that, and an id they do not know must fail closed
 * rather than reach a resolver and become a lookup miss at run time.
 */

import type { GuideProgram, WaitInstruction } from "./ast.js";
import type { GuideParseError } from "./errors.js";
import type {
  GuideGoalId,
  GuidePredicateId,
  GuideRouteId,
  GuideTargetId,
} from "./ids.js";
import { parseGuide } from "./parse.js";

export type GuideVocabulary = {
  readonly goals: readonly GuideGoalId[];
  readonly targets: readonly GuideTargetId[];
  readonly routes: readonly GuideRouteId[];
  readonly predicates: readonly GuidePredicateId[];
};

export type GuideValidationErrorCode =
  | "unknown_goal"
  | "unknown_target"
  | "unknown_route"
  | "unknown_predicate";

export type GuideValidationError = {
  readonly code: GuideValidationErrorCode;
  readonly index: number;
  readonly id: string;
};

export type GuideValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errors: readonly GuideValidationError[] };

export type GuideCompileResult =
  | { readonly ok: true; readonly program: GuideProgram }
  | {
      readonly ok: false;
      readonly stage: "parse";
      readonly errors: readonly GuideParseError[];
    }
  | {
      readonly ok: false;
      readonly stage: "validate";
      readonly errors: readonly GuideValidationError[];
    };

/** The goal is program metadata, not an instruction, so it has no index. */
export const GUIDE_GOAL_INDEX = -1;

export function validateGuide(
  program: GuideProgram,
  vocabulary: GuideVocabulary,
): GuideValidationResult {
  const errors: GuideValidationError[] = [];
  if (!vocabulary.goals.includes(program.goal)) {
    errors.push({
      code: "unknown_goal",
      index: GUIDE_GOAL_INDEX,
      id: program.goal,
    });
  }

  for (let index = 0; index < program.instructions.length; index += 1) {
    const instruction = program.instructions[index];
    if (instruction === undefined) continue;
    switch (instruction.kind) {
      case "focus":
      case "hint":
      case "annotate":
      case "scroll":
        if (!vocabulary.targets.includes(instruction.target)) {
          errors.push({
            code: "unknown_target",
            index,
            id: instruction.target,
          });
        }
        break;
      case "navigate":
        if (!vocabulary.routes.includes(instruction.route)) {
          errors.push({ code: "unknown_route", index, id: instruction.route });
        }
        break;
      case "wait": {
        const failure = waitError(instruction, index, vocabulary);
        if (failure !== null) errors.push(failure);
        break;
      }
      default:
        break;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true };
}

function waitError(
  instruction: WaitInstruction,
  index: number,
  vocabulary: GuideVocabulary,
): GuideValidationError | null {
  switch (instruction.subject) {
    case "target":
      return vocabulary.targets.includes(instruction.target)
        ? null
        : { code: "unknown_target", index, id: instruction.target };
    case "route":
      return vocabulary.routes.includes(instruction.route)
        ? null
        : { code: "unknown_route", index, id: instruction.route };
    case "state":
      return vocabulary.predicates.includes(instruction.predicate)
        ? null
        : { code: "unknown_predicate", index, id: instruction.predicate };
  }
}

export function compileGuide(
  source: string,
  vocabulary: GuideVocabulary,
): GuideCompileResult {
  const parsed = parseGuide(source);
  if (!parsed.ok) return { ok: false, stage: "parse", errors: parsed.errors };
  const validated = validateGuide(parsed.program, vocabulary);
  if (!validated.ok) {
    return { ok: false, stage: "validate", errors: validated.errors };
  }
  return { ok: true, program: parsed.program };
}
