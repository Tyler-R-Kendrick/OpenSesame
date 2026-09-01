/**
 * Canonical GuideLang v1 text.
 *
 * One program has exactly one serialization: named arguments in a fixed
 * order, one escaping decision per character, no optional whitespace. Two
 * equal programs therefore produce byte-identical text, which is what lets a
 * transcript, an audit record and a cache key all agree on what the model
 * actually asked for.
 */

import {
  GUIDE_LANG_HEADER,
  type GuideInstruction,
  type GuideProgram,
  type GuideSide,
  type WaitInstruction,
} from "./ast.js";

export function serializeGuide(program: GuideProgram): string {
  const lines = [GUIDE_LANG_HEADER, `goal ${quoteText(program.goal)}`];
  for (const instruction of program.instructions) {
    lines.push(serializeInstruction(instruction));
  }
  return `${lines.join("\n")}\n`;
}

export function serializeInstruction(instruction: GuideInstruction): string {
  switch (instruction.kind) {
    case "say":
      return `say ${quoteText(instruction.message)}`;
    case "success":
      return `success ${quoteText(instruction.message)}`;
    case "focus":
    case "hint":
    case "annotate":
      return `${instruction.kind} ${quoteText(instruction.target)} ${quoteText(
        instruction.message,
      )}${sideSuffix(instruction.side)}`;
    case "scroll":
      return `scroll ${quoteText(instruction.target)}`;
    case "navigate":
      return `navigate ${quoteText(instruction.route)}`;
    case "wait":
      return serializeWait(instruction);
    case "pause":
      return "pause";
    case "end":
      return "end";
  }
}

function serializeWait(instruction: WaitInstruction): string {
  switch (instruction.subject) {
    case "target":
      return `wait target ${quoteText(instruction.target)} event=${
        instruction.event
      } timeout=${instruction.timeoutMs}`;
    case "route":
      return `wait route ${quoteText(instruction.route)} timeout=${instruction.timeoutMs}`;
    case "state":
      return `wait state ${quoteText(instruction.predicate)} is=${
        instruction.expected ? "true" : "false"
      } timeout=${instruction.timeoutMs}`;
  }
}

function sideSuffix(side: GuideSide | null): string {
  return side === null ? "" : ` side=${side}`;
}

/**
 * Minimal JSON string escaping: only the two characters that would end or
 * re-open the literal, and the control characters that cannot appear raw.
 * Everything else — astral plane included — is emitted as itself, so the text
 * a person reads in the transcript is the text the parser will read back.
 */
function quoteText(value: string): string {
  let quoted = '"';
  for (const character of value) {
    if (character === '"') {
      quoted += '\\"';
      continue;
    }
    if (character === "\\") {
      quoted += "\\\\";
      continue;
    }
    const code = character.codePointAt(0) ?? 0;
    quoted += code < 0x20 ? controlEscape(code) : character;
  }
  return `${quoted}"`;
}

function controlEscape(code: number): string {
  if (code === 0x08) return "\\b";
  if (code === 0x09) return "\\t";
  if (code === 0x0a) return "\\n";
  if (code === 0x0c) return "\\f";
  if (code === 0x0d) return "\\r";
  return `\\u${code.toString(16).padStart(4, "0")}`;
}
