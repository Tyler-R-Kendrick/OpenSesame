/** Lexical refusal checks only; native JSON.parse remains the grammar validator. */
import { z } from "zod";

const MAX_DEPTH = 8;
type Frame =
  | { kind: "object"; keys: Set<string>; expectsKey: boolean }
  | { kind: "array" };

function invalid(): never {
  throw new Error("Retired credential records are unavailable.");
}

function utf8Length(text: string, maxBytes: number): void {
  if (text.length > maxBytes) invalid();
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) invalid();
      i++;
      bytes += 4;
    } else {
      if (unit >= 0xdc00 && unit <= 0xdfff) invalid();
      bytes += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
    if (bytes > maxBytes) invalid();
  }
}

type QuotedStringToken = { text: string; end: number };

function quotedString(raw: string, start: number): QuotedStringToken {
  const jsonText = z.string();
  let end = start + 1;
  while (end < raw.length && raw.charAt(end) !== '"') {
    if (raw.charAt(end) === "\\") end++;
    end++;
  }
  if (end >= raw.length) invalid();
  return { text: jsonText.parse(JSON.parse(raw.slice(start, end + 1))), end };
}

function containerToken(ch: string, stack: Frame[]): void {
  const frame = stack.at(-1);
  if (ch === "{" || ch === "[") {
    if (stack.length >= MAX_DEPTH) invalid();
    stack.push(
      ch === "{"
        ? { kind: "object", keys: new Set<string>(), expectsKey: true }
        : { kind: "array" },
    );
  } else if (ch === "}" || ch === "]") {
    if (
      !frame ||
      (ch === "}" ? frame.kind !== "object" : frame.kind !== "array")
    )
      invalid();
    stack.pop();
  } else if (frame?.kind === "object") {
    if (ch === ":") frame.expectsKey = false;
    if (ch === ",") frame.expectsKey = true;
  }
}

/** Bounded raw scan, then decoded-key equality; no object construction or recursion. */
export function assertUnambiguousJson(raw: string, maxBytes: number): void {
  utf8Length(raw, maxBytes);
  const stack: Frame[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '"') {
      const token = quotedString(raw, i);
      utf8Length(token.text, maxBytes);
      const frame = stack.at(-1);
      if (frame?.kind === "object" && frame.expectsKey) {
        if (frame.keys.has(token.text)) invalid();
        frame.keys.add(token.text);
      }
      i = token.end;
    } else {
      containerToken(ch, stack);
    }
  }
  if (stack.length) invalid();
}
