/**
 * The GuideLang v1 parser.
 *
 * Hand-written on purpose. The input is a string a language model wrote, so
 * the scanner never hands a whole line to a general-purpose decoder: string
 * literals are walked character by character, and every escape, budget and
 * identifier is checked before a value exists in the AST at all.
 *
 * Parsing is all-or-nothing. A program whose first three lines are valid and
 * whose fourth is `click "#login"` yields no program — there is no prefix to
 * execute, so a partially-injected trajectory cannot half-run.
 */

import {
  GUIDE_LANG_VERSION,
  GUIDE_LIMITS,
  type GuideInstruction,
  type GuideInstructionName,
  type GuideLimits,
  type GuideProgram,
  type GuideSide,
  type GuideWaitEvent,
  countGuideTextCharacters,
  isGuideInstructionName,
  isGuideSide,
  isGuideWaitEvent,
  isTerminalInstruction,
} from "./ast.js";
import {
  type GuideParseError,
  type GuideParseErrorCode,
  guideParseError,
} from "./errors.js";
import {
  isGuideGoalId,
  isGuidePredicateId,
  isGuideRouteId,
  isGuideTargetId,
} from "./ids.js";
import {
  type ScannedToken,
  type StringToken,
  forbiddenCharacterIndex,
  splitLines,
  tokenizeLine,
} from "./lex.js";

export type GuideParseResult =
  | { readonly ok: true; readonly program: GuideProgram }
  | { readonly ok: false; readonly errors: readonly GuideParseError[] };

type NamedArgument = { readonly value: string; readonly column: number };

/** Everything a directive reader needs to report a diagnostic in place. */
type LineContext = {
  readonly lineNumber: number;
  /** Column just past the end of the line, where a missing argument belongs. */
  readonly endColumn: number;
  readonly errors: GuideParseError[];
};

const HEADER_LINE = /^guide\/([0-9]{1,4})$/;
const NAMED_ARGUMENT = /^([a-z][a-z0-9]*)=(.*)$/;
const DECIMAL_DIGITS = /^[0-9]+$/;
const GOAL_DIRECTIVE = "goal";
const NO_NAMED_ARGUMENTS = [] as const;
const SIDE_ONLY = ["side"] as const;
const TARGET_WAIT_ARGUMENTS = ["event", "timeout"] as const;
const ROUTE_WAIT_ARGUMENTS = ["timeout"] as const;
const STATE_WAIT_ARGUMENTS = ["is", "timeout"] as const;
/** Beyond this a timeout cannot be represented exactly, and is out of range anyway. */
const MAX_TIMEOUT_DIGITS = 9;

const utf8 = new TextEncoder();

export function parseGuide(
  source: string,
  limits: GuideLimits = GUIDE_LIMITS,
): GuideParseResult {
  if (utf8.encode(source).length > limits.maxProgramBytes) {
    return { ok: false, errors: [guideParseError("program_too_large", 1, 1)] };
  }

  const lines = splitLines(source);
  if (lines.length > limits.maxLines) {
    return {
      ok: false,
      errors: [guideParseError("too_many_lines", limits.maxLines + 1, 1)],
    };
  }

  const errors: GuideParseError[] = [];
  const instructions: GuideInstruction[] = [];
  let headerLine = 0;
  let goalId: string | null = null;
  let goalCount = 0;
  let instructionLines = 0;
  let terminated = false;
  let reportedOverflow = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed === "") continue;

    const forbiddenAt = forbiddenCharacterIndex(line);
    if (forbiddenAt >= 0) {
      errors.push(
        guideParseError("forbidden_character", lineNumber, forbiddenAt + 1),
      );
      continue;
    }

    if (headerLine === 0) {
      const header = HEADER_LINE.exec(trimmed);
      if (header === null) {
        errors.push(guideParseError("missing_version_header", lineNumber, 1));
        return { ok: false, errors };
      }
      if (Number.parseInt(header[1] ?? "", 10) !== GUIDE_LANG_VERSION) {
        errors.push(guideParseError("unsupported_version", lineNumber, 1));
        return { ok: false, errors };
      }
      headerLine = lineNumber;
      continue;
    }

    if (HEADER_LINE.test(trimmed)) {
      errors.push(guideParseError("duplicate_version_header", lineNumber, 1));
      continue;
    }

    const scan = tokenizeLine(line);
    if (!scan.ok) {
      errors.push(guideParseError(scan.code, lineNumber, scan.column));
      continue;
    }

    const head = scan.tokens[0];
    if (head === undefined) continue;
    if (head.kind !== "word") {
      errors.push(
        guideParseError("unknown_instruction", lineNumber, head.column),
      );
      continue;
    }

    const context: LineContext = {
      lineNumber,
      endColumn: line.length + 1,
      errors,
    };

    if (head.text === GOAL_DIRECTIVE) {
      goalCount += 1;
      if (goalCount > 1) {
        errors.push(guideParseError("duplicate_goal", lineNumber, head.column));
      } else if (instructionLines > 0) {
        errors.push(guideParseError("goal_not_first", lineNumber, head.column));
      }
      const declared = readGoal(scan.tokens, context);
      if (declared !== null && goalId === null) goalId = declared;
      continue;
    }

    if (!isGuideInstructionName(head.text)) {
      errors.push(
        guideParseError("unknown_instruction", lineNumber, head.column),
      );
      continue;
    }

    if (terminated) {
      errors.push(
        guideParseError("instruction_after_terminal", lineNumber, head.column),
      );
      continue;
    }

    instructionLines += 1;
    if (instructionLines > limits.maxInstructions) {
      if (!reportedOverflow) {
        errors.push(
          guideParseError("too_many_instructions", lineNumber, head.column),
        );
        reportedOverflow = true;
      }
      continue;
    }

    const instruction = readInstruction(head.text, scan.tokens, context);
    if (instruction === null) continue;
    instructions.push(instruction);
    if (isTerminalInstruction(instruction)) terminated = true;
  }

  if (headerLine === 0) {
    errors.push(guideParseError("empty_program", 1, 1));
  } else if (goalCount === 0) {
    errors.push(guideParseError("missing_goal", headerLine + 1, 1));
  }

  if (errors.length > 0) return { ok: false, errors };
  if (goalId === null) {
    return { ok: false, errors: [guideParseError("missing_goal", 1, 1)] };
  }
  return {
    ok: true,
    program: { version: GUIDE_LANG_VERSION, goal: goalId, instructions },
  };
}

/**
 * A trailing newline ends the last line rather than starting an empty one, so
 * a well-formed file is not one line over budget for having one.
 */
/** Every directive-level diagnostic lands on the line the reader is holding. */
function report(
  context: LineContext,
  code: GuideParseErrorCode,
  column: number,
): void {
  context.errors.push(guideParseError(code, context.lineNumber, column));
}

function readStrings(
  tokens: readonly ScannedToken[],
  start: number,
  count: number,
  context: LineContext,
): readonly StringToken[] | null {
  const values: StringToken[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    const token = tokens[start + offset];
    if (token === undefined) {
      report(context, "malformed_arguments", context.endColumn);
      return null;
    }
    if (token.kind !== "string") {
      report(context, "malformed_arguments", token.column);
      return null;
    }
    values.push(token);
  }
  return values;
}

function readNamedArguments(
  tokens: readonly ScannedToken[],
  start: number,
  allowed: readonly string[],
  context: LineContext,
): ReadonlyMap<string, NamedArgument> | null {
  const found = new Map<string, NamedArgument>();
  let accepted = true;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.kind === "string") {
      report(context, "malformed_arguments", token.column);
      accepted = false;
      continue;
    }
    const match = NAMED_ARGUMENT.exec(token.text);
    const name = match === null ? null : (match[1] ?? null);
    const value = match === null ? null : (match[2] ?? null);
    if (name === null || value === null) {
      report(context, "trailing_content", token.column);
      accepted = false;
      continue;
    }
    if (!allowed.includes(name)) {
      report(context, "unknown_named_argument", token.column);
      accepted = false;
      continue;
    }
    if (found.has(name)) {
      report(context, "duplicate_named_argument", token.column);
      accepted = false;
      continue;
    }
    found.set(name, { value, column: token.column });
  }
  return accepted ? found : null;
}

function readGoal(
  tokens: readonly ScannedToken[],
  context: LineContext,
): string | null {
  const values = readStrings(tokens, 1, 1, context);
  if (values === null) return null;
  const declared = values[0];
  if (declared === undefined) return null;
  if (readNamedArguments(tokens, 2, NO_NAMED_ARGUMENTS, context) === null)
    return null;
  if (!isGuideGoalId(declared.value)) {
    report(context, "invalid_identifier", declared.column);
    return null;
  }
  return declared.value;
}

function readInstruction(
  name: GuideInstructionName,
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  switch (name) {
    case "say":
    case "success":
      return readMessageInstruction(name, tokens, context);
    case "focus":
    case "hint":
    case "annotate":
      return readPopoverInstruction(name, tokens, context);
    case "scroll":
      return readScroll(tokens, context);
    case "navigate":
      return readNavigate(tokens, context);
    case "wait":
      return readWait(tokens, context);
    case "pause":
    case "end":
      return readTerminal(name, tokens, context);
  }
}

function readMessageInstruction(
  name: "say" | "success",
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  const values = readStrings(tokens, 1, 1, context);
  if (values === null) return null;
  const message = values[0];
  if (message === undefined) return null;
  if (readNamedArguments(tokens, 2, NO_NAMED_ARGUMENTS, context) === null)
    return null;
  if (!checkMessage(message, context)) return null;
  return name === "say"
    ? { kind: "say", message: message.value }
    : { kind: "success", message: message.value };
}

function readPopoverInstruction(
  name: "focus" | "hint" | "annotate",
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  const values = readStrings(tokens, 1, 2, context);
  if (values === null) return null;
  const target = values[0];
  const message = values[1];
  if (target === undefined || message === undefined) return null;
  const named = readNamedArguments(tokens, 3, SIDE_ONLY, context);
  if (named === null) return null;

  let accepted = checkTarget(target, context);
  if (!checkMessage(message, context)) accepted = false;

  let side: GuideSide | null = null;
  const declaredSide = named.get("side");
  if (declaredSide !== undefined) {
    if (isGuideSide(declaredSide.value)) {
      side = declaredSide.value;
    } else {
      report(context, "invalid_side", declaredSide.column);
      accepted = false;
    }
  }
  if (!accepted) return null;

  if (name === "focus") {
    return {
      kind: "focus",
      target: target.value,
      message: message.value,
      side,
    };
  }
  if (name === "hint") {
    return { kind: "hint", target: target.value, message: message.value, side };
  }
  return {
    kind: "annotate",
    target: target.value,
    message: message.value,
    side,
  };
}

function readScroll(
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  const values = readStrings(tokens, 1, 1, context);
  if (values === null) return null;
  const target = values[0];
  if (target === undefined) return null;
  if (readNamedArguments(tokens, 2, NO_NAMED_ARGUMENTS, context) === null)
    return null;
  if (!checkTarget(target, context)) return null;
  return { kind: "scroll", target: target.value };
}

function readNavigate(
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  const values = readStrings(tokens, 1, 1, context);
  if (values === null) return null;
  const route = values[0];
  if (route === undefined) return null;
  if (readNamedArguments(tokens, 2, NO_NAMED_ARGUMENTS, context) === null)
    return null;
  if (!checkRoute(route, context)) return null;
  return { kind: "navigate", route: route.value };
}

function readWait(
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  const subject = tokens[1];
  if (subject === undefined) {
    report(context, "malformed_arguments", context.endColumn);
    return null;
  }
  const declared = subject.kind === "word" ? subject.text : "";
  if (declared !== "target" && declared !== "route" && declared !== "state") {
    report(context, "invalid_wait_subject", subject.column);
    return null;
  }

  const values = readStrings(tokens, 2, 1, context);
  if (values === null) return null;
  const named = readNamedArguments(
    tokens,
    3,
    declared === "target"
      ? TARGET_WAIT_ARGUMENTS
      : declared === "state"
        ? STATE_WAIT_ARGUMENTS
        : ROUTE_WAIT_ARGUMENTS,
    context,
  );
  if (named === null) return null;

  const subjectId = values[0];
  if (subjectId === undefined) return null;
  const timeoutMs = readTimeout(named.get("timeout") ?? null, context);

  if (declared === "route") {
    if (!checkRoute(subjectId, context) || timeoutMs === null) return null;
    return {
      kind: "wait",
      subject: "route",
      route: subjectId.value,
      timeoutMs,
    };
  }

  if (declared === "state") {
    const expected = readBoolean(named.get("is") ?? null, context);
    const accepted = checkPredicate(subjectId, context);
    if (!accepted || expected === null || timeoutMs === null) return null;
    return {
      kind: "wait",
      subject: "state",
      predicate: subjectId.value,
      expected,
      timeoutMs,
    };
  }

  const event = readWaitEvent(named.get("event") ?? null, context);
  const accepted = checkTarget(subjectId, context);
  if (!accepted || event === null || timeoutMs === null) return null;
  return {
    kind: "wait",
    subject: "target",
    target: subjectId.value,
    event,
    timeoutMs,
  };
}

function readTerminal(
  name: "pause" | "end",
  tokens: readonly ScannedToken[],
  context: LineContext,
): GuideInstruction | null {
  if (readNamedArguments(tokens, 1, NO_NAMED_ARGUMENTS, context) === null)
    return null;
  return name === "pause" ? { kind: "pause" } : { kind: "end" };
}

function readTimeout(
  argument: NamedArgument | null,
  context: LineContext,
): number | null {
  if (argument === null) {
    report(context, "malformed_arguments", context.endColumn);
    return null;
  }
  if (!DECIMAL_DIGITS.test(argument.value)) {
    report(context, "timeout_not_an_integer", argument.column);
    return null;
  }
  const timeoutMs = Number.parseInt(argument.value, 10);
  if (
    argument.value.length > MAX_TIMEOUT_DIGITS ||
    timeoutMs < GUIDE_LIMITS.minTimeoutMs ||
    timeoutMs > GUIDE_LIMITS.maxTimeoutMs
  ) {
    report(context, "timeout_out_of_range", argument.column);
    return null;
  }
  return timeoutMs;
}

function readBoolean(
  argument: NamedArgument | null,
  context: LineContext,
): boolean | null {
  if (argument === null) {
    report(context, "malformed_arguments", context.endColumn);
    return null;
  }
  if (argument.value === "true") return true;
  if (argument.value === "false") return false;
  report(context, "invalid_boolean", argument.column);
  return null;
}

function readWaitEvent(
  argument: NamedArgument | null,
  context: LineContext,
): GuideWaitEvent | null {
  if (argument === null) {
    report(context, "malformed_arguments", context.endColumn);
    return null;
  }
  if (isGuideWaitEvent(argument.value)) return argument.value;
  report(context, "invalid_wait_event", argument.column);
  return null;
}

function checkTarget(token: StringToken, context: LineContext): boolean {
  if (isGuideTargetId(token.value)) return true;
  report(context, "invalid_identifier", token.column);
  return false;
}

function checkPredicate(token: StringToken, context: LineContext): boolean {
  if (isGuidePredicateId(token.value)) return true;
  report(context, "invalid_identifier", token.column);
  return false;
}

function checkRoute(token: StringToken, context: LineContext): boolean {
  if (isGuideRouteId(token.value)) return true;
  report(context, "invalid_route", token.column);
  return false;
}

function checkMessage(token: StringToken, context: LineContext): boolean {
  let accepted = true;
  if (countGuideTextCharacters(token.value) > GUIDE_LIMITS.maxMessageChars) {
    report(context, "message_too_long", token.column);
    accepted = false;
  }
  if (forbiddenCharacterIndex(token.value) >= 0) {
    report(context, "forbidden_character", token.column);
    accepted = false;
  }
  return accepted;
}

/** Code points, not UTF-16 units: an emoji is one character to the person reading it. */
