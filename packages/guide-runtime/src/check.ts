/**
 * Re-validation of a program against the live registries. The parser checked
 * all of this already; the runtime asks again because it must never trust the
 * thing that fed it (see `checkProgram`).
 */

import {
  GUIDE_LANG_VERSION,
  GUIDE_LIMITS,
  type GuideInstruction,
  type GuideLimits,
  type GuidePredicateId,
  type GuideProgram,
  type GuideRouteId,
  type GuideSide,
  type GuideTargetId,
  type WaitInstruction,
  countGuideTextCharacters,
  hasForbiddenTextCharacter,
  isGuideGoalId,
  isGuidePredicateId,
  isGuideRouteId,
  isGuideSide,
  isGuideTargetId,
  isGuideWaitEvent,
  isTerminalInstruction,
} from "@opensesame/guide-lang";

import type { GuideRuntimeError, GuideRuntimePorts } from "./ports.js";

export function validationError(detail: string): GuideRuntimeError {
  return { code: "GUIDE_VALIDATION_ERROR", detail };
}

function checkMessage(message: string): GuideRuntimeError | null {
  // Code points, matching the parser. Counting UTF-16 units here rejected
  // astral text the compiler had already accepted.
  if (countGuideTextCharacters(message) > GUIDE_LIMITS.maxMessageChars) {
    return validationError("maxMessageChars");
  }
  if (hasForbiddenTextCharacter(message)) {
    return validationError("forbiddenTextCharacter");
  }
  return null;
}

function checkSide(side: GuideSide | null): GuideRuntimeError | null {
  return side === null || isGuideSide(side) ? null : validationError("side");
}

/**
 * A syntactically invalid identifier fails as a validation error rather than
 * an unknown one: `detail` reaches logs and the support transcript, and only
 * a string that already matched the semantic-id grammar is safe to put there.
 * Anything else is still model-authored text.
 */
function checkTarget(
  ports: GuideRuntimePorts,
  target: GuideTargetId,
): GuideRuntimeError | null {
  if (!isGuideTargetId(target)) return validationError("target");
  if (!ports.targets.isKnown(target)) {
    return { code: "UNKNOWN_TARGET", detail: target };
  }
  return null;
}

function checkRoute(
  ports: GuideRuntimePorts,
  route: GuideRouteId,
): GuideRuntimeError | null {
  if (!isGuideRouteId(route)) return validationError("route");
  if (!ports.routes.isKnown(route)) {
    return { code: "UNKNOWN_ROUTE", detail: route };
  }
  return null;
}

function checkPredicate(
  ports: GuideRuntimePorts,
  predicate: GuidePredicateId,
): GuideRuntimeError | null {
  if (!isGuidePredicateId(predicate)) return validationError("predicate");
  if (!ports.state.isKnown(predicate)) {
    return { code: "UNKNOWN_PREDICATE", detail: predicate };
  }
  return null;
}

function checkWait(
  ports: GuideRuntimePorts,
  instruction: WaitInstruction,
): GuideRuntimeError | null {
  const { timeoutMs } = instruction;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < GUIDE_LIMITS.minTimeoutMs ||
    timeoutMs > GUIDE_LIMITS.maxTimeoutMs
  ) {
    return validationError("timeoutMs");
  }
  if (instruction.subject === "target") {
    return isGuideWaitEvent(instruction.event)
      ? checkTarget(ports, instruction.target)
      : validationError("event");
  }
  if (instruction.subject === "route") {
    return checkRoute(ports, instruction.route);
  }
  return checkPredicate(ports, instruction.predicate);
}

function checkInstruction(
  ports: GuideRuntimePorts,
  instruction: GuideInstruction,
): GuideRuntimeError | null {
  switch (instruction.kind) {
    case "say":
    case "success":
      return checkMessage(instruction.message);
    case "focus":
    case "hint":
    case "annotate":
      return (
        checkMessage(instruction.message) ??
        checkSide(instruction.side) ??
        checkTarget(ports, instruction.target)
      );
    case "scroll":
      return checkTarget(ports, instruction.target);
    case "navigate":
      return checkRoute(ports, instruction.route);
    case "wait":
      return checkWait(ports, instruction);
    default:
      return null;
  }
}

/**
 * Every budget and every vocabulary membership, re-checked here against the
 * live registries. The parser checked the same things, and that is precisely
 * why this exists: a runtime that trusted the parser is one refactor away from
 * executing an 800-step trajectory against targets nobody registered.
 *
 * The source-text budgets (`maxProgramBytes`, `maxLines`) are deliberately not
 * re-checked — an AST has no source text, and the parser owns that boundary.
 */
export function checkProgram(
  ports: GuideRuntimePorts,
  program: GuideProgram,
  limits: GuideLimits = GUIDE_LIMITS,
): GuideRuntimeError | null {
  if (program.version !== GUIDE_LANG_VERSION) return validationError("version");
  if (!isGuideGoalId(program.goal)) return validationError("goal");
  if (program.instructions.length > limits.maxInstructions) {
    return validationError("maxInstructions");
  }
  const last = program.instructions.length - 1;
  for (let index = 0; index <= last; index += 1) {
    const instruction = program.instructions[index];
    if (instruction === undefined) return validationError("instructions");
    if (index !== last && isTerminalInstruction(instruction)) {
      return validationError("terminal");
    }
    const error = checkInstruction(ports, instruction);
    if (error !== null) return error;
  }
  return null;
}
