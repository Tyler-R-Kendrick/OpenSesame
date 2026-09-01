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
  GUIDE_LANG_HEADER,
  GUIDE_LANG_VERSION,
  GUIDE_LIMITS,
  type GuideInstruction,
  type GuideInstructionName,
  type GuideProgram,
  type GuideSide,
  type GuideWaitEvent,
  countGuideTextCharacters,
  hasForbiddenTextCharacter,
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

export type GuideParseResult =
  | { readonly ok: true; readonly program: GuideProgram }
  | { readonly ok: false; readonly errors: readonly GuideParseError[] };

type StringToken = {
  readonly kind: "string";
  readonly value: string;
  readonly column: number;
};

type WordToken = {
  readonly kind: "word";
  readonly text: string;
  readonly column: number;
};

type ScannedToken = StringToken | WordToken;

type ScanFailure = {
  readonly ok: false;
  readonly code: GuideParseErrorCode;
  readonly column: number;
};

type StringScan =
  | { readonly ok: true; readonly value: string; readonly next: number }
  | ScanFailure;

type LineScan =
  | { readonly ok: true; readonly tokens: readonly ScannedToken[] }
  | ScanFailure;

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

export function parseGuide(source: string): GuideParseResult {
  if (utf8.encode(source).length > GUIDE_LIMITS.maxProgramBytes) {
    return { ok: false, errors: [guideParseError("program_too_large", 1, 1)] };
  }

  const lines = splitLines(source);
  if (lines.length > GUIDE_LIMITS.maxLines) {
    return {
      ok: false,
      errors: [guideParseError("too_many_lines", GUIDE_LIMITS.maxLines + 1, 1)],
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
    if (instructionLines > GUIDE_LIMITS.maxInstructions) {
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
function splitLines(source: string): readonly string[] {
  const raw = source.split("\n");
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Index of the first character no rendered guide may carry: the C0/C1, bidi
 * and zero-width ranges the AST module names, plus an unpaired surrogate,
 * which survives a naive validator and renders as something else.
 */
function forbiddenCharacterIndex(line: string): number {
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (hasForbiddenTextCharacter(character)) return index;
    const unit = line.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < line.length ? line.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return index;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return index;
  }
  return -1;
}

function tokenizeLine(line: string): LineScan {
  const tokens: ScannedToken[] = [];
  let index = 0;
  while (index < line.length) {
    const character = line.charAt(index);
    if (character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (character === '"') {
      const scanned = scanStringLiteral(line, index);
      if (!scanned.ok) return scanned;
      tokens.push({ kind: "string", value: scanned.value, column: index + 1 });
      index = scanned.next;
      continue;
    }
    const start = index;
    while (index < line.length) {
      const next = line.charAt(index);
      if (next === " " || next === "\t") break;
      index += 1;
    }
    tokens.push({
      kind: "word",
      text: line.slice(start, index),
      column: start + 1,
    });
  }
  return { ok: true, tokens };
}

function scanStringLiteral(line: string, start: number): StringScan {
  let index = start + 1;
  let value = "";
  while (index < line.length) {
    const unit = line.charCodeAt(index);
    if (unit === 0x22) return { ok: true, value, next: index + 1 };
    if (unit === 0x5c) {
      const escaped = readEscape(line, index);
      if (!escaped.ok) return escaped;
      value += escaped.value;
      index = escaped.next;
      continue;
    }
    if (unit < 0x20) {
      return { ok: false, code: "forbidden_character", column: index + 1 };
    }
    value += line.charAt(index);
    index += 1;
  }
  return { ok: false, code: "unterminated_string", column: start + 1 };
}

/**
 * JSON escapes only, and a `\u` escape must resolve to a whole code point:
 * an unpaired surrogate is how a string survives one validator and renders as
 * something else downstream.
 */
function readEscape(line: string, at: number): StringScan {
  const marker = at + 1;
  if (marker >= line.length) {
    return { ok: false, code: "unterminated_string", column: at + 1 };
  }
  const character = line.charAt(marker);
  if (character === '"') return { ok: true, value: '"', next: marker + 1 };
  if (character === "\\") return { ok: true, value: "\\", next: marker + 1 };
  if (character === "/") return { ok: true, value: "/", next: marker + 1 };
  if (character === "b") return { ok: true, value: "\b", next: marker + 1 };
  if (character === "f") return { ok: true, value: "\f", next: marker + 1 };
  if (character === "n") return { ok: true, value: "\n", next: marker + 1 };
  if (character === "r") return { ok: true, value: "\r", next: marker + 1 };
  if (character === "t") return { ok: true, value: "\t", next: marker + 1 };
  if (character !== "u") {
    return { ok: false, code: "invalid_string_escape", column: at + 1 };
  }

  const leading = readHexQuad(line, marker + 1);
  if (leading === null || (leading >= 0xdc00 && leading <= 0xdfff)) {
    return { ok: false, code: "invalid_string_escape", column: at + 1 };
  }
  if (leading < 0xd800 || leading > 0xdbff) {
    return { ok: true, value: String.fromCharCode(leading), next: marker + 5 };
  }
  if (line.charAt(marker + 5) !== "\\" || line.charAt(marker + 6) !== "u") {
    return { ok: false, code: "invalid_string_escape", column: at + 1 };
  }
  const trailing = readHexQuad(line, marker + 7);
  if (trailing === null || trailing < 0xdc00 || trailing > 0xdfff) {
    return { ok: false, code: "invalid_string_escape", column: at + 1 };
  }
  return {
    ok: true,
    value: String.fromCharCode(leading, trailing),
    next: marker + 11,
  };
}

function readHexQuad(line: string, at: number): number | null {
  if (at + 4 > line.length) return null;
  let value = 0;
  for (let offset = 0; offset < 4; offset += 1) {
    const digit = hexDigit(line.charCodeAt(at + offset));
    if (digit === null) return null;
    value = value * 16 + digit;
  }
  return value;
}

function hexDigit(unit: number): number | null {
  if (unit >= 0x30 && unit <= 0x39) return unit - 0x30;
  if (unit >= 0x61 && unit <= 0x66) return unit - 0x61 + 10;
  if (unit >= 0x41 && unit <= 0x46) return unit - 0x41 + 10;
  return null;
}

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
