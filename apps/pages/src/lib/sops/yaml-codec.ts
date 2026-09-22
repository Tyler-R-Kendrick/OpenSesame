/** YAML document codec using the pinned `yaml` parser, not object round-trip. */

import {
  Document,
  Pair,
  Scalar,
  YAMLMap,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
  parseDocument,
} from "yaml";
import type { Node, Scalar as YamlScalar } from "yaml";
import type { SopsScalar } from "./aes-record.js";
import type { SopsEntry, SopsNode } from "./tree.js";

const MAX_INPUT = 8 * 1024 * 1024;

type YamlResolved = string | number | boolean | bigint | null;

function resolved(node: YamlScalar): YamlResolved {
  if (node.value === null || node.value === true || node.value === false) {
    return node.value;
  }
  const label = Object.prototype.toString.call(node.value);
  if (
    label === "[object BigInt]" ||
    label === "[object Number]" ||
    label === "[object String]"
  ) {
    // SAFETY: the yaml parser established this scalar is a string, number, or bigint.
    return node.value as YamlResolved;
  }
  throw new Error("unsupported YAML scalar");
}

function scalarFromNode(node: YamlScalar): SopsNode {
  const value = resolved(node);
  if (value === null) return { kind: "null" };
  if (value === true || value === false) {
    return { kind: "scalar", scalar: { kind: "bool", value } };
  }
  const label = Object.prototype.toString.call(value);
  if (label === "[object BigInt]") {
    return { kind: "scalar", scalar: { kind: "int", value: String(value) } };
  }
  if (label === "[object Number]") {
    // SAFETY: the checked number label matches a finite YAML number.
    const number = value as number;
    if (!Number.isFinite(number)) throw new Error("non-finite YAML number");
    if (Number.isSafeInteger(number)) {
      return { kind: "scalar", scalar: { kind: "int", value: String(number) } };
    }
    return { kind: "scalar", scalar: { kind: "float", value: String(number) } };
  }
  return { kind: "scalar", scalar: { kind: "str", value: String(value) } };
}

function mapKey(node: Node | null): string {
  if (!isScalar(node)) throw new Error("YAML mapping keys must be strings");
  const value = resolved(node);
  if (Object.prototype.toString.call(value) !== "[object String]") {
    throw new Error("YAML mapping keys must be strings");
  }
  return String(value);
}

function fromNode(node: Node | null): SopsNode {
  if (isMap(node)) {
    const entries: SopsEntry[] = [];
    const seen = new Set<string>();
    for (const pair of node.items) {
      // SAFETY: YAMLMap pair keys are parser nodes produced by `yaml`.
      const keyNode = pair.key as Node | null;
      const key = mapKey(keyNode);
      if (seen.has(key)) throw new Error("duplicate YAML key");
      seen.add(key);
      // SAFETY: YAMLMap pair values are parser nodes produced by `yaml`.
      const value = fromNode(pair.value as Node | null);
      const comments =
        keyNode && "commentBefore" in keyNode && keyNode.commentBefore
          ? keyNode.commentBefore
              .split("\n")
              .map((line) => line.replace(/^#\s?/u, "").trim())
              .filter((line) => line.length > 0)
          : [];
      if (comments.length > 0) entries.push({ key, value, comments });
      else entries.push({ key, value });
    }
    return { kind: "map", entries };
  }
  if (isSeq(node)) {
    return {
      kind: "seq",
      items: node.items.map((item) => {
        // SAFETY: YAML sequence items are parser nodes produced by `yaml`.
        return fromNode(item as Node | null);
      }),
    };
  }
  if (isScalar(node)) return scalarFromNode(node);
  if (node === null) return { kind: "null" };
  throw new Error("unsupported YAML node");
}

export function parseYamlDocuments(text: string): SopsNode[] {
  if (text.length > MAX_INPUT) throw new Error("sops input exceeds 8 MiB");
  const docs = parseAllDocuments(text, { intAsBigInt: true, uniqueKeys: true });
  if (docs.length > 32) throw new Error("too many YAML documents");
  if (docs.some((doc) => doc.errors.length > 0))
    throw new Error("YAML parse failed");
  if (docs.length === 0) return [{ kind: "map", entries: [] }];
  return docs.map((doc) =>
    doc.contents === null
      ? { kind: "map", entries: [] }
      : fromNode(doc.contents),
  );
}

export function parseYamlTree(text: string): SopsNode {
  const docs = parseYamlDocuments(text);
  const first = docs[0];
  if (!first || docs.length !== 1) {
    throw new Error("YAML stream has more than one document");
  }
  return first;
}

type YamlEmit =
  | YAMLMap
  | YamlScalar
  | string
  | number
  | boolean
  | null
  | YamlEmit[];

function toYaml(node: SopsNode): YamlEmit {
  if (node.kind === "null") return null;
  if (node.kind === "seq") return node.items.map(toYaml);
  if (node.kind === "scalar") return scalarEmit(node.scalar);
  const map = new YAMLMap();
  for (const entry of node.entries) {
    // The key must be a real Scalar node: YAMLMap.set() would keep a plain
    // string key, and commentBefore on a plain string never renders.
    const keyNode = new Scalar(entry.key);
    if (entry.comments && entry.comments.length > 0) {
      keyNode.commentBefore = entry.comments
        .map((comment) => ` ${comment}`)
        .join("\n");
    }
    map.items.push(new Pair(keyNode, toYaml(entry.value)));
  }
  return map;
}

function scalarEmit(scalar: SopsScalar): string | number | boolean | Scalar {
  switch (scalar.kind) {
    case "bool":
      return scalar.value;
    case "int": {
      if (/^-?\d+$/u.test(scalar.value)) {
        const asNumber = Number(scalar.value);
        if (Number.isSafeInteger(asNumber)) return asNumber;
      }
      const node = new Scalar(scalar.value);
      node.tag = "tag:yaml.org,2002:int";
      return node;
    }
    case "float":
      return Number(scalar.value);
    case "str":
    case "comment":
      if (/^\d{4}-\d{2}-\d{2}T/u.test(scalar.value)) {
        const quoted = new Scalar(scalar.value);
        quoted.type = Scalar.QUOTE_DOUBLE;
        return quoted;
      }
      return scalar.value;
    default: {
      const unreachable: never = scalar;
      return unreachable;
    }
  }
}

export function emitYamlTree(node: SopsNode): string {
  const doc = new Document(toYaml(node));
  return doc.toString();
}
