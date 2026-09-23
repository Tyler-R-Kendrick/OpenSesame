/**
 * Ordered JSON codec matching upstream's `stores/json` (26e2f478): keys
 * keep source order (including `"10"`, `"2"`, `"__proto__"`), integers in
 * the int64 range stay exact, and `-0` normalizes to `0` as Go's
 * `json.Number.Int64` does.
 *
 * Stricter than upstream on purpose: a duplicate key is refused (upstream
 * keeps both entries), an integer beyond int64 is refused (upstream silently
 * converts it to a float), and a lone surrogate escape is refused (Go
 * substitutes U+FFFD).
 */

import { SopsError } from "./errors.js";
import { MAX_INPUT_BYTES, MAX_KEY_LENGTH } from "./limits.js";
import { type SopsNode, assertTreeBudget } from "./model.js";
import {
  type SopsScalar,
  assertScalarBudget,
  canonicalInt,
  goParseFloatText,
} from "./scalars.js";

function jsonEscape(esc: string): string {
  switch (esc) {
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      throw new SopsError(
        "invalid_document",
        "A JSON string has a bad escape.",
      );
  }
}

class Parser {
  readonly #text: string;
  #i = 0;

  constructor(text: string) {
    if (text.length > MAX_INPUT_BYTES) {
      throw new SopsError(
        "resource_limit",
        "The document exceeds the input budget.",
      );
    }
    this.#text = text;
  }

  parse(): SopsNode {
    this.#skip();
    if (this.#peek() !== "{") {
      throw new SopsError(
        "invalid_document",
        "A SOPS JSON document must be a top-level object.",
      );
    }
    const node = this.#object();
    this.#skip();
    if (this.#i !== this.#text.length) {
      throw new SopsError("invalid_document", "JSON has trailing content.");
    }
    return node;
  }

  #peek(): string {
    return this.#text.charAt(this.#i);
  }

  #skip(): void {
    while (this.#i < this.#text.length && /[ \t\n\r]/u.test(this.#peek()))
      this.#i += 1;
  }

  #value(): SopsNode {
    this.#skip();
    const ch = this.#peek();
    if (ch === "{") return this.#object();
    if (ch === "[") return this.#array();
    if (ch === '"') {
      const value = this.#string();
      assertScalarBudget(value);
      return { kind: "scalar", scalar: { kind: "str", value } };
    }
    if (ch === "t" || ch === "f") return this.#bool();
    if (ch === "n") return this.#null();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.#number();
    throw new SopsError("invalid_document", "JSON is malformed.");
  }

  #object(): SopsNode {
    this.#i += 1;
    const items: SopsNode & { kind: "map" } = { kind: "map", items: [] };
    const seen = new Set<string>();
    this.#skip();
    if (this.#peek() === "}") {
      this.#i += 1;
      return items;
    }
    while (this.#i < this.#text.length) {
      this.#skip();
      if (this.#peek() !== '"') {
        throw new SopsError("invalid_document", "A JSON key must be a string.");
      }
      const key = this.#string();
      if (key.length > MAX_KEY_LENGTH) {
        throw new SopsError(
          "resource_limit",
          "A mapping key exceeds the key budget.",
        );
      }
      if (seen.has(key))
        throw new SopsError("duplicate_key", "A mapping repeats a key.");
      seen.add(key);
      this.#skip();
      if (this.#peek() !== ":") {
        throw new SopsError(
          "invalid_document",
          "A JSON key is missing its colon.",
        );
      }
      this.#i += 1;
      items.items.push({ kind: "entry", key, value: this.#value() });
      this.#skip();
      const sep = this.#peek();
      this.#i += 1;
      if (sep === "}") return items;
      if (sep !== ",")
        throw new SopsError("invalid_document", "A JSON object is malformed.");
    }
    throw new SopsError("invalid_document", "A JSON object is unterminated.");
  }

  #array(): SopsNode {
    this.#i += 1;
    const node: SopsNode & { kind: "seq" } = { kind: "seq", items: [] };
    this.#skip();
    if (this.#peek() === "]") {
      this.#i += 1;
      return node;
    }
    while (this.#i < this.#text.length) {
      node.items.push(this.#value());
      this.#skip();
      const sep = this.#peek();
      this.#i += 1;
      if (sep === "]") return node;
      if (sep !== ",")
        throw new SopsError("invalid_document", "A JSON array is malformed.");
    }
    throw new SopsError("invalid_document", "A JSON array is unterminated.");
  }

  #unicodeEscape(): string {
    const hex = this.#text.slice(this.#i, this.#i + 4);
    if (!/^[0-9a-fA-F]{4}$/u.test(hex)) {
      throw new SopsError(
        "invalid_document",
        "A JSON unicode escape is malformed.",
      );
    }
    this.#i += 4;
    const code = Number.parseInt(hex, 16);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (this.#text.slice(this.#i, this.#i + 2) !== "\\u") {
        throw new SopsError(
          "malformed_encoding",
          "A JSON string has a lone surrogate.",
        );
      }
      this.#i += 2;
      const low = this.#text.slice(this.#i, this.#i + 4);
      const lowCode = Number.parseInt(low, 16);
      if (
        !/^[0-9a-fA-F]{4}$/u.test(low) ||
        lowCode < 0xdc00 ||
        lowCode > 0xdfff
      ) {
        throw new SopsError(
          "malformed_encoding",
          "A JSON string has a lone surrogate.",
        );
      }
      this.#i += 4;
      return String.fromCharCode(code, lowCode);
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new SopsError(
        "malformed_encoding",
        "A JSON string has a lone surrogate.",
      );
    }
    return String.fromCharCode(code);
  }

  #string(): string {
    this.#i += 1;
    let out = "";
    while (this.#i < this.#text.length) {
      const ch = this.#peek();
      this.#i += 1;
      if (ch === '"') return out;
      if (ch === "\\") {
        const esc = this.#peek();
        this.#i += 1;
        out += esc === "u" ? this.#unicodeEscape() : jsonEscape(esc);
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) {
        throw new SopsError(
          "invalid_document",
          "A JSON string has a raw control character.",
        );
      }
      out += ch;
    }
    throw new SopsError("invalid_document", "A JSON string is unterminated.");
  }

  #bool(): SopsNode {
    const word = this.#peek() === "t" ? "true" : "false";
    if (this.#text.slice(this.#i, this.#i + word.length) !== word) {
      throw new SopsError("invalid_document", "JSON is malformed.");
    }
    this.#i += word.length;
    return { kind: "scalar", scalar: { kind: "bool", value: word === "true" } };
  }

  #null(): SopsNode {
    if (this.#text.slice(this.#i, this.#i + 4) !== "null") {
      throw new SopsError("invalid_document", "JSON is malformed.");
    }
    this.#i += 4;
    return { kind: "null" };
  }

  #digits(): void {
    if (!/[0-9]/u.test(this.#peek())) {
      throw new SopsError("invalid_document", "A JSON number is malformed.");
    }
    while (/[0-9]/u.test(this.#peek())) this.#i += 1;
  }

  #number(): SopsNode {
    const start = this.#i;
    if (this.#peek() === "-") this.#i += 1;
    if (this.#peek() === "0") this.#i += 1;
    else this.#digits();
    let float = false;
    if (this.#peek() === ".") {
      float = true;
      this.#i += 1;
      this.#digits();
    }
    if (this.#peek() === "e" || this.#peek() === "E") {
      float = true;
      this.#i += 1;
      if (this.#peek() === "+" || this.#peek() === "-") this.#i += 1;
      this.#digits();
    }
    const raw = this.#text.slice(start, this.#i);
    if (!float) {
      const value = canonicalInt(BigInt(raw));
      if (value === null) {
        throw new SopsError(
          "unsupported_feature",
          "An integer is outside the 64-bit signed range SOPS supports.",
        );
      }
      return { kind: "scalar", scalar: { kind: "int", value } };
    }
    const value = goParseFloatText(raw);
    if (value === null) {
      throw new SopsError(
        "unsupported_feature",
        "A number is outside the float64 range.",
      );
    }
    return { kind: "scalar", scalar: { kind: "float", value } };
  }
}

export function parseJsonTree(text: string): SopsNode {
  const root = new Parser(text).parse();
  assertTreeBudget([root]);
  return root;
}

function withFraction(text: string): string {
  return /[.eE]/u.test(text) ? text : `${text}.0`;
}

function emitScalar(scalar: SopsScalar): string {
  switch (scalar.kind) {
    case "str":
    case "time":
      return JSON.stringify(scalar.value);
    case "int":
      return scalar.value;
    case "float":
      if (!Number.isFinite(scalar.value)) {
        // Upstream's encoder refuses these too (`json: unsupported value`).
        throw new SopsError(
          "unsupported_feature",
          "JSON cannot carry an infinite or NaN number.",
        );
      }
      if (Object.is(scalar.value, -0)) return "-0.0";
      // Upstream's `json.Marshal` writes 1 for 1.0; that reads back as an
      // int, so the fraction is kept here to preserve the float kind.
      return withFraction(JSON.stringify(scalar.value));
    case "bool":
      return scalar.value ? "true" : "false";
    default: {
      const unreachable: never = scalar;
      return unreachable;
    }
  }
}

function emit(node: SopsNode, indent: string, depth: number): string {
  const pad = indent.repeat(depth + 1);
  const close = indent.repeat(depth);
  switch (node.kind) {
    case "null":
      return "null";
    case "scalar":
      return emitScalar(node.scalar);
    case "seq": {
      const items = node.items.filter((item) => item.kind !== "comment");
      if (items.length === 0) return "[]";
      return `[\n${items.map((item) => `${pad}${emit(item, indent, depth + 1)}`).join(",\n")}\n${close}]`;
    }
    case "map": {
      const items = node.items.filter((item) => item.kind === "entry");
      if (items.length === 0) return "{}";
      return `{\n${items
        .map(
          (item) =>
            `${pad}${JSON.stringify(item.key)}: ${emit(item.value, indent, depth + 1)}`,
        )
        .join(",\n")}\n${close}}`;
    }
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

/** Pretty JSON with a trailing newline, comments dropped as upstream does. */
export function emitJsonTree(node: SopsNode): string {
  return `${emit(node, "\t", 0)}\n`;
}
