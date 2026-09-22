/**
 * Ordered SOPS trees → YAML text the pinned Go loader reads back with the
 * same types, order, and comment items (B05). Formatting is normalized (two
 * space indent, no line folding); a document that was not changed is never
 * re-emitted by the engine, so a no-op open leaves the external file alone.
 */

import { Document, Pair, Scalar, type ScalarTag, YAMLMap, YAMLSeq } from "yaml";
import { SopsError } from "./errors.js";
import type { SopsComment, SopsNode } from "./model.js";
import { type SopsScalar, goFloatText } from "./scalars.js";
import { plainReadsAsString } from "./yaml-resolve.js";

type Emitted = YAMLMap | YAMLSeq | Scalar;

/**
 * A scalar rendered verbatim as a plain token. The library would otherwise
 * quote "1" or "2001-12-14T00:00:00Z" when handed a string, and it formats
 * numbers its own way; the engine owns those bytes.
 */
class PlainText {
  constructor(readonly text: string) {}
}

const plainTextTag: ScalarTag = {
  identify: (value) => value instanceof PlainText,
  tag: "tag:yaml.org,2002:str",
  default: true,
  resolve: (text) => text,
  stringify: (item) =>
    item.value instanceof PlainText ? item.value.text : String(item.value),
};

function plain(text: string): Scalar {
  const node = new Scalar(new PlainText(text));
  node.type = Scalar.PLAIN;
  return node;
}

/** A C0/DEL control other than the newline a block scalar carries. */
function hasControlCharacter(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x0a) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function needsQuotes(text: string): boolean {
  if (text === "" || text !== text.trim()) return true;
  if (hasControlCharacter(text)) return true;
  return !plainReadsAsString(text);
}

function stringScalar(text: string): Scalar {
  const scalar = new Scalar(text);
  if (text.includes("\n")) scalar.type = Scalar.BLOCK_LITERAL;
  else if (needsQuotes(text)) scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
}

function floatText(value: number): string {
  if (Number.isNaN(value)) return ".nan";
  if (value === Number.POSITIVE_INFINITY) return ".inf";
  if (value === Number.NEGATIVE_INFINITY) return "-.inf";
  const text = goFloatText(value);
  return /[.eE]/u.test(text) ? text : `${text}.0`;
}

function scalarNode(scalar: SopsScalar): Scalar {
  switch (scalar.kind) {
    case "str":
      return stringScalar(scalar.value);
    case "int":
    case "time":
      return plain(scalar.value);
    case "float":
      return plain(floatText(scalar.value));
    case "bool":
      return plain(scalar.value ? "true" : "false");
    default: {
      const unreachable: never = scalar;
      return unreachable;
    }
  }
}

function commentLine(item: SopsComment): string {
  if (item.value.includes("\n") || item.value.includes("\r")) {
    throw new SopsError(
      "malformed_encoding",
      "A comment spans more than one line.",
    );
  }
  // The library renders a single-space line as a bare `#`, which reads back
  // as an empty comment; a bare empty line would be dropped instead.
  return item.value === "" ? " " : item.value;
}

function applyHead(node: Emitted, lines: string[]): void {
  if (lines.length === 0) return;
  node.commentBefore = lines.join("\n");
  lines.length = 0;
}

function applyInline(node: Emitted, key: Scalar | null, lines: string[]): void {
  if (lines.length === 0) return;
  const target = node instanceof Scalar || key === null ? node : key;
  target.comment = lines.join("\n");
  lines.length = 0;
}

function nullScalar(): Scalar {
  return plain("null");
}

function emitSeq(node: Extract<SopsNode, { kind: "seq" }>): YAMLSeq {
  const seq = new YAMLSeq();
  const head: string[] = [];
  const inline: string[] = [];
  for (const item of node.items) {
    if (item.kind === "comment") {
      (item.inline ? inline : head).push(commentLine(item));
      continue;
    }
    const emitted = emitNode(item);
    applyHead(emitted, head);
    applyInline(emitted, null, inline);
    seq.items.push(emitted);
  }
  const foot = [...head, ...inline];
  if (foot.length > 0) {
    if (seq.items.length === 0) seq.commentBefore = foot.join("\n");
    else seq.comment = foot.join("\n");
  }
  if (seq.items.length === 0) seq.flow = true;
  return seq;
}

function emitMap(node: Extract<SopsNode, { kind: "map" }>): YAMLMap {
  const map = new YAMLMap();
  const head: string[] = [];
  const inline: string[] = [];
  for (const item of node.items) {
    if (item.kind === "comment") {
      (item.inline ? inline : head).push(commentLine(item));
      continue;
    }
    const key = stringScalar(item.key);
    const value = emitNode(item.value);
    applyHead(key, head);
    applyInline(value, key, inline);
    map.items.push(new Pair(key, value));
  }
  const foot = [...head, ...inline];
  if (foot.length > 0) {
    if (map.items.length === 0) map.commentBefore = foot.join("\n");
    else map.comment = foot.join("\n");
  }
  if (map.items.length === 0) map.flow = true;
  return map;
}

function emitNode(node: SopsNode): Emitted {
  switch (node.kind) {
    case "null":
      return nullScalar();
    case "scalar":
      return scalarNode(node.scalar);
    case "seq":
      return emitSeq(node);
    case "map":
      return emitMap(node);
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

/** Emit one document (no `---` marker). */
export function emitYamlDocument(root: SopsNode): string {
  if (root.kind !== "map") {
    throw new SopsError(
      "invalid_document",
      "A SOPS YAML document must be a mapping.",
    );
  }
  const doc = new Document(null, { customTags: [plainTextTag] });
  doc.contents = emitNode(root);
  return doc.toString({ lineWidth: 0, indent: 2, minContentWidth: 0 });
}

/** Emit a stream, one document per root, separated by `---`. */
export function emitYamlStream(roots: readonly SopsNode[]): string {
  return roots.map(emitYamlDocument).join("---\n");
}
