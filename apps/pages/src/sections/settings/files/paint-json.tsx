/**
 * One line of JSON, painted by a single left-to-right scan. A regular
 * expression over a string body backtracks without bound on a line of `\"`
 * outside any string; this walks each character once.
 */
import type { ReactNode } from "react";

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERALS = ["true", "false", "null"];

function isWord(char: string | undefined): boolean {
  return char !== undefined && /\w/.test(char);
}

/** Where a string opened at `from` ends (exclusive); the line's end when it
 * never closes. */
function stringEnd(line: string, from: number): number {
  let at = from + 1;
  while (at < line.length) {
    const char = line[at];
    if (char === "\\") at += 2;
    else if (char === '"') return at + 1;
    else at += 1;
  }
  return line.length;
}

/** Whether a `:` follows `from`, past any blanks. */
function colonFollows(line: string, from: number): boolean {
  let at = from;
  while (at < line.length && /\s/.test(line[at] ?? "")) at += 1;
  return line[at] === ":";
}

function literalAt(line: string, at: number): string | undefined {
  if (isWord(line[at - 1])) return undefined;
  const found = LITERALS.find((word) => line.startsWith(word, at));
  if (found === undefined || isWord(line[at + found.length])) return undefined;
  return found;
}

/** Keys, strings, numbers and the three literals; every character is kept. */
export function paintJsonLine(line: string): ReactNode {
  const out: ReactNode[] = [];
  let plain = 0;
  let at = 0;
  /** Paint `[at, end)` as a token and carry on after it. */
  const take = (end: number, className: string) => {
    if (at > plain) out.push(line.slice(plain, at));
    out.push(
      <span key={at} className={className}>
        {line.slice(at, end)}
      </span>,
    );
    plain = end;
    at = end;
  };
  while (at < line.length) {
    const char = line[at] ?? "";
    if (char === '"') {
      const end = stringEnd(line, at);
      take(end, colonFollows(line, end) ? "set-raw__key" : "set-raw__str");
      continue;
    }
    if (char === "-" || (char >= "0" && char <= "9")) {
      NUMBER.lastIndex = at;
      const hit = NUMBER.exec(line);
      if (hit) {
        take(at + hit[0].length, "set-raw__num");
        continue;
      }
    }
    const literal =
      char === "t" || char === "f" || char === "n"
        ? literalAt(line, at)
        : undefined;
    if (literal !== undefined) {
      take(at + literal.length, "set-raw__bool");
      continue;
    }
    at += 1;
  }
  if (plain < line.length) out.push(line.slice(plain));
  return out;
}
