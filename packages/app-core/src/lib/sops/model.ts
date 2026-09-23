/**
 * The ordered SOPS tree (B05), shaped like upstream's `TreeBranch`: a
 * mapping is a list of entries and comment items in source order, a
 * sequence is a list of values and comment items, and comments are items
 * rather than annotations because upstream walks and encrypts them as such.
 */

import { SopsError } from "./errors.js";
import { MAX_TREE_DEPTH, MAX_TREE_NODES } from "./limits.js";
import type { SopsScalar } from "./scalars.js";

export type SopsComment = {
  kind: "comment";
  /** The line after `#`, leading space included, exactly as upstream keeps it. */
  value: string;
  /** A line comment after a value (YAML layout only; never authenticated). */
  inline: boolean;
};

export type SopsEntry = { kind: "entry"; key: string; value: SopsNode };

export type SopsMapItem = SopsComment | SopsEntry;

export type SopsSeqItem = SopsComment | SopsNode;

export type SopsNode =
  | { kind: "map"; items: SopsMapItem[] }
  | { kind: "seq"; items: SopsSeqItem[] }
  | { kind: "scalar"; scalar: SopsScalar }
  | { kind: "null" };

export type SopsMap = Extract<SopsNode, { kind: "map" }>;

export function isComment(
  item: SopsMapItem | SopsSeqItem,
): item is SopsComment {
  return item.kind === "comment";
}

export function entry(node: SopsNode, key: string): SopsNode | undefined {
  if (node.kind !== "map") return undefined;
  for (const item of node.items) {
    if (item.kind === "entry" && item.key === key) return item.value;
  }
  return undefined;
}

export function entries(node: SopsNode): SopsEntry[] {
  if (node.kind !== "map") return [];
  const out: SopsEntry[] = [];
  for (const item of node.items) if (item.kind === "entry") out.push(item);
  return out;
}

export function scalarText(node: SopsNode | undefined): string | undefined {
  if (!node || node.kind !== "scalar" || node.scalar.kind !== "str") {
    return undefined;
  }
  return node.scalar.value;
}

export function str(value: string): SopsNode {
  return { kind: "scalar", scalar: { kind: "str", value } };
}

export function map(items: SopsMapItem[]): SopsMap {
  return { kind: "map", items };
}

export function setEntry(key: string, value: SopsNode): SopsEntry {
  return { kind: "entry", key, value };
}

export function withoutEntry(node: SopsMap, key: string): SopsMap {
  return map(
    node.items.filter((item) => item.kind !== "entry" || item.key !== key),
  );
}

/** Depth and node-count bounds, applied before any cryptographic work. */
export function assertTreeBudget(roots: readonly SopsNode[]): void {
  let nodes = 0;
  const visit = (node: SopsNode, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_TREE_NODES) {
      throw new SopsError("resource_limit", "The document has too many nodes.");
    }
    if (depth > MAX_TREE_DEPTH) {
      throw new SopsError("resource_limit", "The document nests too deeply.");
    }
    if (node.kind === "map") {
      for (const item of node.items) {
        if (item.kind === "entry") visit(item.value, depth + 1);
      }
    } else if (node.kind === "seq") {
      for (const item of node.items) {
        if (item.kind !== "comment") visit(item, depth + 1);
      }
    }
  };
  for (const root of roots) visit(root, 1);
}

export function cloneNode(node: SopsNode): SopsNode {
  switch (node.kind) {
    case "null":
      return { kind: "null" };
    case "scalar":
      return { kind: "scalar", scalar: { ...node.scalar } };
    case "seq":
      return {
        kind: "seq",
        items: node.items.map((item) =>
          item.kind === "comment" ? { ...item } : cloneNode(item),
        ),
      };
    case "map":
      return {
        kind: "map",
        items: node.items.map((item) =>
          item.kind === "comment"
            ? { ...item }
            : { kind: "entry", key: item.key, value: cloneNode(item.value) },
        ),
      };
    default: {
      const unreachable: never = node;
      return unreachable;
    }
  }
}

/** Deep structural equality, comments included (upstream `equals`). */
export function nodeEquals(a: SopsNode, b: SopsNode): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "null") return true;
  if (a.kind === "scalar" && b.kind === "scalar") {
    if (a.scalar.kind !== b.scalar.kind) return false;
    return a.scalar.kind === "float" && b.scalar.kind === "float"
      ? Object.is(a.scalar.value, b.scalar.value)
      : a.scalar.value === b.scalar.value;
  }
  if (a.kind === "seq" && b.kind === "seq") {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, index) => {
      const other = b.items[index];
      if (!other) return false;
      if (item.kind === "comment" || other.kind === "comment") {
        return (
          item.kind === "comment" &&
          other.kind === "comment" &&
          item.value === other.value
        );
      }
      return nodeEquals(item, other);
    });
  }
  if (a.kind === "map" && b.kind === "map") {
    if (a.items.length !== b.items.length) return false;
    return a.items.every((item, index) => {
      const other = b.items[index];
      if (!other || item.kind !== other.kind) return false;
      if (item.kind === "comment" && other.kind === "comment") {
        return item.value === other.value;
      }
      if (item.kind === "entry" && other.kind === "entry") {
        return item.key === other.key && nodeEquals(item.value, other.value);
      }
      return false;
    });
  }
  return false;
}
