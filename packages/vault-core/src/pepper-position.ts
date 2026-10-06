/**
 * Where a pepper goes in a produced password (ADR 0174).
 *
 * A pepper is a secret the person keeps and the product never sees: it is not
 * asked for and not stored. What a method keeps is *where* it goes, written the
 * way Python writes an index into a string, so a person can say it in one
 * short expression:
 *
 * - empty, or `end`: after the last character (the default);
 * - `3`: before the character at index 3, so `password[:3] + pepper +
 *   password[3:]`; a negative index counts from the end, so `-2` is before the
 *   last two characters;
 * - `2:5`, `:4`, `-3:`: the pepper stands in for `password[2:5]`, the first
 *   four characters, the last three. Either bound may be left out, and the
 *   brackets of `[2:5]` are accepted.
 *
 * Bounds clamp the way Python's do and never raise, so an expression is valid or
 * it is not text a person can have meant; there is no step. Positions count
 * characters as Python does (code points, not UTF-16 units), only ASCII
 * whitespace is dropped, and `end` is read in ASCII case alone, so the Rust twin
 * and the Python reference in `scripts/test/pepper-position-reference.py` agree
 * with this file on every expression (`spec/conformance/pepper-position-vectors.json`).
 */

export type PepperPosition =
  | { kind: "insert"; index: number }
  | { kind: "replace"; start: number | null; stop: number | null };

/** A password cut where the pepper goes: `head + pepper + tail` is the whole. */
export type PepperSplit = { head: string; tail: string };

const INTEGER = /^[+-]?[0-9]+$/u;
const ASCII_SPACE = /[ \t\n\v\f\r]+/gu;
const END = "end";

function bound(text: string): number | null | undefined {
  if (text === "") return null;
  return INTEGER.test(text) ? Number.parseInt(text, 10) : undefined;
}

/** `end` in any ASCII case, and nothing else (no locale, no Unicode folding). */
function isEnd(text: string): boolean {
  return (
    text.length === END.length &&
    Array.from(text).every(
      (char, i) => char === END[i] || char === END[i]?.toUpperCase(),
    )
  );
}

/** The position an expression names, or `null` when it is not one. */
export function parsePepperPosition(expression: string): PepperPosition | null {
  let text = expression.replaceAll(ASCII_SPACE, "");
  if (text.length >= 2 && text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }
  if (text === "" || isEnd(text)) {
    return { kind: "insert", index: Number.POSITIVE_INFINITY };
  }
  if (!text.includes(":")) {
    return INTEGER.test(text)
      ? { kind: "insert", index: Number.parseInt(text, 10) }
      : null;
  }
  const parts = text.split(":");
  if (parts.length !== 2) return null;
  const [from = "", to = ""] = parts;
  const start = bound(from);
  const stop = bound(to);
  return start === undefined || stop === undefined
    ? null
    : { kind: "replace", start, stop };
}

/** Python's slice normalisation for one bound over a string of `length`. */
function clamp(index: number, length: number): number {
  const absolute = index < 0 ? index + length : index;
  return Math.min(Math.max(absolute, 0), length);
}

/**
 * Cut `password` where `expression` says the pepper goes. An expression that is
 * not valid cuts at the end, which is what an empty one means.
 */
export function splitAtPepper(
  password: string,
  expression: string | undefined,
): PepperSplit {
  const points = Array.from(password);
  const length = points.length;
  const position = parsePepperPosition(expression ?? "") ?? {
    kind: "insert" as const,
    index: Number.POSITIVE_INFINITY,
  };
  if (position.kind === "insert") {
    const at = clamp(position.index, length);
    return {
      head: points.slice(0, at).join(""),
      tail: points.slice(at).join(""),
    };
  }
  const start = position.start === null ? 0 : clamp(position.start, length);
  const stop = position.stop === null ? length : clamp(position.stop, length);
  return {
    head: points.slice(0, start).join(""),
    tail: points.slice(Math.max(start, stop)).join(""),
  };
}

/** Whether `expression` is one a person can save: empty, or a position. */
export function isPepperPosition(expression: string): boolean {
  return parsePepperPosition(expression) !== null;
}
