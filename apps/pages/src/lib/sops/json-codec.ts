/** Ordered JSON codec. Integer-looking keys stay in source order. */

import type { SopsScalar } from "./aes-record.js";
import type { SopsNode } from "./tree.js";

const MAX_INPUT = 8 * 1024 * 1024;

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
      throw new Error("bad JSON escape");
  }
}

class Parser {
  #text: string;
  #i = 0;

  constructor(text: string) {
    if (text.length > MAX_INPUT) throw new Error("sops input exceeds 8 MiB");
    this.#text = text;
  }

  parse(): SopsNode {
    this.#skip();
    const node = this.#value();
    this.#skip();
    if (this.#i !== this.#text.length) throw new Error("trailing JSON");
    return node;
  }

  #peek(): string {
    return this.#text.charAt(this.#i);
  }

  #skip(): void {
    while (this.#i < this.#text.length && /\s/u.test(this.#peek()))
      this.#i += 1;
  }

  #value(): SopsNode {
    this.#skip();
    const ch = this.#peek();
    if (ch === "{") return this.#object();
    if (ch === "[") return this.#array();
    if (ch === '"')
      return { kind: "scalar", scalar: { kind: "str", value: this.#string() } };
    if (ch === "t" || ch === "f") return this.#bool();
    if (ch === "n") return this.#null();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.#number();
    throw new Error("malformed JSON");
  }

  #object(): SopsNode {
    this.#i += 1;
    const entries: { key: string; value: SopsNode }[] = [];
    const seen = new Set<string>();
    this.#skip();
    if (this.#peek() === "}") {
      this.#i += 1;
      return { kind: "map", entries };
    }
    while (this.#i < this.#text.length) {
      this.#skip();
      if (this.#peek() !== '"') throw new Error("JSON key must be a string");
      const key = this.#string();
      if (seen.has(key)) throw new Error("duplicate JSON key");
      seen.add(key);
      this.#skip();
      if (this.#peek() !== ":") throw new Error("JSON key missing colon");
      this.#i += 1;
      entries.push({ key, value: this.#value() });
      this.#skip();
      const sep = this.#peek();
      this.#i += 1;
      if (sep === "}") return { kind: "map", entries };
      if (sep !== ",") throw new Error("malformed JSON object");
    }
    throw new Error("unterminated JSON object");
  }

  #array(): SopsNode {
    this.#i += 1;
    const items: SopsNode[] = [];
    this.#skip();
    if (this.#peek() === "]") {
      this.#i += 1;
      return { kind: "seq", items };
    }
    while (this.#i < this.#text.length) {
      items.push(this.#value());
      this.#skip();
      const sep = this.#peek();
      this.#i += 1;
      if (sep === "]") return { kind: "seq", items };
      if (sep !== ",") throw new Error("malformed JSON array");
    }
    throw new Error("unterminated JSON array");
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
        if (esc === "u") {
          const hex = this.#text.slice(this.#i, this.#i + 4);
          if (!/^[0-9a-fA-F]{4}$/u.test(hex))
            throw new Error("bad unicode escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.#i += 4;
          continue;
        }
        const mapped = jsonEscape(esc);
        out += mapped;
        continue;
      }
      if (ch.charCodeAt(0) < 0x20)
        throw new Error("raw control in JSON string");
      out += ch;
    }
    throw new Error("unterminated JSON string");
  }

  #bool(): SopsNode {
    const word = this.#peek() === "t" ? "true" : "false";
    if (this.#text.slice(this.#i, this.#i + word.length) !== word) {
      throw new Error("malformed JSON bool");
    }
    this.#i += word.length;
    return { kind: "scalar", scalar: { kind: "bool", value: word === "true" } };
  }

  #null(): SopsNode {
    if (this.#text.slice(this.#i, this.#i + 4) !== "null")
      throw new Error("malformed JSON null");
    this.#i += 4;
    return { kind: "null" };
  }

  #number(): SopsNode {
    const start = this.#i;
    if (this.#peek() === "-") this.#i += 1;
    if (this.#peek() === "0") this.#i += 1;
    else {
      if (!/[1-9]/u.test(this.#peek()))
        throw new Error("malformed JSON number");
      while (/[0-9]/u.test(this.#peek())) this.#i += 1;
    }
    let kind: "int" | "float" = "int";
    if (this.#peek() === ".") {
      kind = "float";
      this.#i += 1;
      if (!/[0-9]/u.test(this.#peek()))
        throw new Error("malformed JSON number");
      while (/[0-9]/u.test(this.#peek())) this.#i += 1;
    }
    if (this.#peek() === "e" || this.#peek() === "E") {
      kind = "float";
      this.#i += 1;
      if (this.#peek() === "+" || this.#peek() === "-") this.#i += 1;
      if (!/[0-9]/u.test(this.#peek()))
        throw new Error("malformed JSON number");
      while (/[0-9]/u.test(this.#peek())) this.#i += 1;
    }
    const raw = this.#text.slice(start, this.#i);
    const scalar: SopsScalar =
      kind === "int"
        ? { kind: "int", value: raw }
        : { kind: "float", value: raw };
    return { kind: "scalar", scalar };
  }
}

export function parseJsonTree(text: string): SopsNode {
  return new Parser(text).parse();
}

function emitScalar(scalar: SopsScalar): string {
  switch (scalar.kind) {
    case "str":
    case "comment":
      return JSON.stringify(scalar.value);
    case "int":
    case "float":
      return scalar.value;
    case "bool":
      return scalar.value ? "true" : "false";
    default: {
      const unreachable: never = scalar;
      return unreachable;
    }
  }
}

export function emitJsonTree(node: SopsNode): string {
  if (node.kind === "null") return "null";
  if (node.kind === "scalar") return emitScalar(node.scalar);
  if (node.kind === "seq") return `[${node.items.map(emitJsonTree).join(",")}]`;
  return `{${node.entries
    .map((entry) => `${JSON.stringify(entry.key)}:${emitJsonTree(entry.value)}`)
    .join(",")}}`;
}
