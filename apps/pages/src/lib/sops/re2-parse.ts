/**
 * The parser for the Go/RE2 subset SOPS selectors use (see `re2.ts` for
 * why the engine is its own rather than a JavaScript `RegExp`).
 *
 * Accepted: literals, `.`, `^`, `$`, character classes with ranges and
 * negation, the `\d \D \s \S \w \W` classes, the standard control
 * escapes, escaped metacharacters, groups (capturing and `(?:…)`),
 * alternation, and the `* + ? {n} {n,} {n,m}` quantifiers, each with an
 * optional non-greedy `?` — which is all Go allows after a quantifier, so
 * `a**` and `a{2}+` are refused exactly as upstream refuses them.
 *
 * Two kinds of refusal, both explicit and neither a guess. Lookaround and
 * backreferences are not in RE2 at all, so no SOPS config can rely on
 * them. Inline flags, named groups, Unicode classes, POSIX classes,
 * `\Q…\E`, `\A`, `\z`, `\C` and `\x{…}` *are* valid RE2 that this
 * engine deliberately does not implement; a config using one is reported
 * as unsupported rather than reinterpreted.
 */

import { SopsError } from "./errors.js";

/** A legitimate selector is far below this. */
export const MAX_REPEAT = 1000;

export type Pred = (code: number) => boolean;

export type Node =
  | { kind: "empty" }
  | { kind: "char"; test: Pred }
  | { kind: "cat"; items: Node[] }
  | { kind: "alt"; items: Node[] }
  | { kind: "repeat"; min: number; max: number | null; item: Node }
  | { kind: "assert"; at: "start" | "end" };

export function refuse(what: string): SopsError {
  return new SopsError(
    "unsupported_feature",
    `A regex uses ${what}, which this engine does not implement.`,
  );
}

/** The `\n`-style escapes this subset understands, by their letter. */
type ControlEscapes = Readonly<Record<string, number>>;
/** The `\d`-style class escapes, by their letter. */
type ClassEscapes = Readonly<Record<string, Pred>>;

const DIGIT: Pred = (code) => code >= 0x30 && code <= 0x39;
const SPACE: Pred = (code) => code === 0x20 || (code >= 0x09 && code <= 0x0d);
const WORD: Pred = (code) =>
  DIGIT(code) ||
  (code >= 0x41 && code <= 0x5a) ||
  (code >= 0x61 && code <= 0x7a) ||
  code === 0x5f;
const negate =
  (test: Pred): Pred =>
  (code) =>
    !test(code);

const CONTROL: ControlEscapes = {
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  f: 0x0c,
  v: 0x0b,
  a: 0x07,
};
const CLASS_ESCAPE: ClassEscapes = {
  d: DIGIT,
  D: negate(DIGIT),
  s: SPACE,
  S: negate(SPACE),
  w: WORD,
  W: negate(WORD),
};
const PUNCTUATION = new Set([..."\\^$.|?*+()[]{}-/"]);

/** A character class member: a class escape, or one literal code point. */
type ClassMember = { test: Pred | null; code: number };

export class Parser {
  readonly #cp: number[];
  #i = 0;

  constructor(pattern: string) {
    this.#cp = [...pattern].map((char) => char.codePointAt(0) ?? 0);
  }

  parse(): Node {
    const node = this.#alternation();
    if (this.#i < this.#cp.length) throw refuse("an unbalanced group");
    return node;
  }

  #peek(offset = 0): string {
    const code = this.#cp[this.#i + offset];
    return code === undefined ? "" : String.fromCodePoint(code);
  }

  #alternation(): Node {
    const items: Node[] = [this.#concat()];
    while (this.#peek() === "|") {
      this.#i += 1;
      items.push(this.#concat());
    }
    return items.length === 1
      ? (items[0] ?? { kind: "empty" })
      : { kind: "alt", items };
  }

  #concat(): Node {
    const items: Node[] = [];
    for (;;) {
      const char = this.#peek();
      if (char === "" || char === "|" || char === ")") break;
      items.push(this.#quantified());
    }
    if (items.length === 0) return { kind: "empty" };
    return items.length === 1
      ? (items[0] ?? { kind: "empty" })
      : { kind: "cat", items };
  }

  #quantified(): Node {
    const atom = this.#atom();
    for (;;) {
      const char = this.#peek();
      let min: number;
      let max: number | null;
      if (char === "*") [min, max] = [0, null];
      else if (char === "+") [min, max] = [1, null];
      else if (char === "?") [min, max] = [0, 1];
      else if (char === "{") {
        const counted = this.#counted();
        if (!counted) return atom;
        [min, max] = counted;
      } else return atom;
      if (char !== "{") this.#i += 1;
      // Go allows exactly one non-greedy `?` after a quantifier; it changes
      // which match is chosen, never whether one exists, and this matcher
      // answers only that. Anything further is Go's "nested repetition".
      if (this.#peek() === "?") this.#i += 1;
      if (
        this.#peek() === "*" ||
        this.#peek() === "+" ||
        this.#peek() === "?"
      ) {
        throw refuse("a nested repetition operator");
      }
      if (this.#peek() === "{" && this.#countedAhead()) {
        throw refuse("a nested repetition operator");
      }
      return { kind: "repeat", min, max, item: atom };
    }
  }

  /** True when a `{…}` at the cursor would parse as a repetition count. */
  #countedAhead(): boolean {
    const start = this.#i;
    try {
      return this.#counted() !== null;
    } finally {
      this.#i = start;
    }
  }

  /** `{n}`, `{n,}`, `{n,m}`; anything else leaves `{` as a literal. */
  #counted(): [number, number | null] | null {
    const start = this.#i;
    this.#i += 1;
    let low = "";
    while (/[0-9]/u.test(this.#peek())) {
      low += this.#peek();
      this.#i += 1;
    }
    if (low === "") {
      this.#i = start;
      return null;
    }
    let high: string | null = low;
    if (this.#peek() === ",") {
      this.#i += 1;
      high = "";
      while (/[0-9]/u.test(this.#peek())) {
        high += this.#peek();
        this.#i += 1;
      }
    }
    if (this.#peek() !== "}") {
      this.#i = start;
      return null;
    }
    this.#i += 1;
    const min = Number(low);
    const max = high === null || high === "" ? null : Number(high);
    if (min > MAX_REPEAT || (max !== null && max > MAX_REPEAT)) {
      throw new SopsError(
        "unsupported_feature",
        `A regex repeats more than ${MAX_REPEAT} times.`,
      );
    }
    if (max !== null && max < min) throw refuse("an inverted repetition count");
    return [min, max];
  }

  #atom(): Node {
    const char = this.#peek();
    if (char === "(") return this.#group();
    if (char === "[") return this.#charClass();
    if (char === "^") {
      this.#i += 1;
      return { kind: "assert", at: "start" };
    }
    if (char === "$") {
      this.#i += 1;
      return { kind: "assert", at: "end" };
    }
    if (char === ".") {
      this.#i += 1;
      return { kind: "char", test: (code) => code !== 0x0a };
    }
    if (char === "*" || char === "+" || char === "?")
      throw refuse("a quantifier with nothing to repeat");
    if (char === "\\") return this.#escape();
    const code = this.#cp[this.#i] ?? 0;
    this.#i += 1;
    return { kind: "char", test: (other) => other === code };
  }

  #group(): Node {
    this.#i += 1;
    if (this.#peek() === "?") {
      // `(?:` is the only prefixed group RE2 and this subset share.
      if (this.#peek(1) !== ":")
        throw refuse("a lookaround, named, or flag group");
      this.#i += 2;
    }
    const inner = this.#alternation();
    if (this.#peek() !== ")") throw refuse("an unbalanced group");
    this.#i += 1;
    return inner;
  }

  #escape(): Node {
    this.#i += 1;
    const char = this.#peek();
    if (char === "") throw refuse("a trailing backslash");
    this.#i += 1;
    const classEscape = CLASS_ESCAPE[char];
    if (classEscape) return { kind: "char", test: classEscape };
    const control = CONTROL[char];
    if (control !== undefined)
      return { kind: "char", test: (code) => code === control };
    if (char === "b" || char === "B") throw refuse("a word boundary");
    if (/[0-9]/u.test(char)) throw refuse("a backreference or octal escape");
    if (/[A-Za-z]/u.test(char)) throw refuse("an unsupported escape");
    const code = char.codePointAt(0) ?? 0;
    if (!PUNCTUATION.has(char) && code > 0x7f)
      throw refuse("an unsupported escape");
    return { kind: "char", test: (other) => other === code };
  }

  /** A class escape, or one literal code point. */
  #classMember(): ClassMember {
    if (this.#peek() === "\\") {
      this.#i += 1;
      const char = this.#peek();
      if (char === "") throw refuse("a trailing backslash");
      this.#i += 1;
      const classEscape = CLASS_ESCAPE[char];
      if (classEscape) return { test: classEscape, code: -1 };
      const control = CONTROL[char];
      if (control !== undefined) return { test: null, code: control };
      if (/[0-9A-Za-z]/u.test(char))
        throw refuse("an unsupported class escape");
      return { test: null, code: char.codePointAt(0) ?? 0 };
    }
    if (this.#peek() === "[" && this.#peek(1) === ":")
      throw refuse("a POSIX class");
    const code = this.#cp[this.#i] ?? 0;
    this.#i += 1;
    return { test: null, code };
  }

  #charClass(): Node {
    this.#i += 1;
    let negated = false;
    if (this.#peek() === "^") {
      negated = true;
      this.#i += 1;
    }
    const tests: Pred[] = [];
    const singles = new Set<number>();
    const ranges: [number, number][] = [];
    let first = true;
    for (;;) {
      const char = this.#peek();
      if (char === "") throw refuse("an unterminated character class");
      if (char === "]" && !first) break;
      first = false;
      const member = this.#classMember();
      if (member.test) {
        tests.push(member.test);
        continue;
      }
      if (
        this.#peek() === "-" &&
        this.#peek(1) !== "]" &&
        this.#peek(1) !== ""
      ) {
        this.#i += 1;
        const upper = this.#classMember();
        if (upper.test) throw refuse("a class range with a class escape");
        if (upper.code < member.code) throw refuse("an inverted class range");
        ranges.push([member.code, upper.code]);
        continue;
      }
      singles.add(member.code);
    }
    this.#i += 1;
    const inside: Pred = (code) => {
      if (singles.has(code)) return true;
      for (const [low, high] of ranges)
        if (code >= low && code <= high) return true;
      for (const test of tests) if (test(code)) return true;
      return false;
    };
    return { kind: "char", test: negated ? negate(inside) : inside };
  }
}

/** Parse a pattern into its AST, refusing anything outside the subset. */
export function parsePattern(pattern: string): Node {
  return new Parser(pattern).parse();
}
