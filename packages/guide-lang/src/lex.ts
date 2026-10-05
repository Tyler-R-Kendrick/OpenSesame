/**
 * The GuideLang scanner: lines, string literals and escapes.
 *
 * A guide is text a language model wrote, so nothing here hands a line to a
 * general-purpose decoder. A string literal is walked character by character,
 * only JSON escapes are understood, and a `\u` escape must resolve to a whole
 * code point. The parser (`parse.ts`) reads the tokens this produces; it never
 * sees a raw line.
 */

import { hasForbiddenTextCharacter } from "./ast.js";
import type { GuideParseErrorCode } from "./errors.js";

export type StringToken = {
  readonly kind: "string";
  readonly value: string;
  readonly column: number;
};

export type WordToken = {
  readonly kind: "word";
  readonly text: string;
  readonly column: number;
};

export type ScannedToken = StringToken | WordToken;

export type ScanFailure = {
  readonly ok: false;
  readonly code: GuideParseErrorCode;
  readonly column: number;
};

export type StringScan =
  | { readonly ok: true; readonly value: string; readonly next: number }
  | ScanFailure;

export type LineScan =
  | { readonly ok: true; readonly tokens: readonly ScannedToken[] }
  | ScanFailure;

export function splitLines(source: string): readonly string[] {
  const raw = source.split("\n");
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Index of the first character no rendered guide may carry: the C0/C1, bidi
 * and zero-width ranges the AST module names, plus an unpaired surrogate,
 * which survives a naive validator and renders as something else.
 */
export function forbiddenCharacterIndex(line: string): number {
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

export function tokenizeLine(line: string): LineScan {
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

const SIMPLE_ESCAPES = new Map<string, string>(
  Object.entries({
    '"': '"',
    "\\": "\\",
    "/": "/",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
  }),
);

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
  const simple = SIMPLE_ESCAPES.get(character);
  if (simple !== undefined)
    return { ok: true, value: simple, next: marker + 1 };
  if (character !== "u") {
    return { ok: false, code: "invalid_string_escape", column: at + 1 };
  }
  return readUnicodeEscape(line, at);
}

/** `\uXXXX`, or a `\uD800\uDC00` pair; anything unpaired is refused. */
function readUnicodeEscape(line: string, at: number): StringScan {
  const marker = at + 1;
  const refused: StringScan = {
    ok: false,
    code: "invalid_string_escape",
    column: at + 1,
  };
  const leading = readHexQuad(line, marker + 1);
  if (leading === null || (leading >= 0xdc00 && leading <= 0xdfff)) {
    return refused;
  }
  if (leading < 0xd800 || leading > 0xdbff) {
    return { ok: true, value: String.fromCharCode(leading), next: marker + 5 };
  }
  if (line.charAt(marker + 5) !== "\\" || line.charAt(marker + 6) !== "u") {
    return refused;
  }
  const trailing = readHexQuad(line, marker + 7);
  if (trailing === null || trailing < 0xdc00 || trailing > 0xdfff) {
    return refused;
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
