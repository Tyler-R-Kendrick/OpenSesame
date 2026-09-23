/**
 * Comment placement as go.yaml.in/yaml/v3 and upstream's YAML store produce
 * it, recovered from source offsets rather than the npm parser's own
 * attachment (which folds trailing comments of several nesting levels into
 * one node). Verified against the pinned loader with the checked-in
 * `fixtures/tree/*.tree.json` cases.
 *
 * Rules, as observed on the pinned loader:
 *  - a comment after a scalar on the same line is inline, placed before
 *    that entry or item; inside a flow collection the same holds;
 *  - a comment after a flow collection's closing bracket becomes the
 *    collection's first item, not inline;
 *  - a comment after `key:` alone is placed before that entry, not inline;
 *  - a comment after `-` alone is placed before the item's content;
 *  - an own-line comment between two nodes belongs to the deepest open
 *    collection whose content indentation is at most the comment's, which
 *    is what turns trailing comments into per-level foot comments.
 */

import type { SopsComment, SopsNode } from "./model.js";

export type ScanCollection = {
  kind: "map" | "seq";
  parent: ScanCollection | null;
  /** Column of the first key or dash; 0 for an empty root. */
  indent: number;
  items: ScanItem[];
  /** Source range of a `{}` / `[]` layout, else null. */
  flowRange: readonly [number, number] | null;
  foot: SopsComment[];
};

export type ScanItem = {
  collection: ScanCollection;
  /** Offset of the key (mapping) or dash (sequence). */
  start: number;
  /** The value's collection when the value is a mapping or sequence. */
  child: ScanCollection | null;
  /** Range of a scalar value: [start, end). */
  valueRange: readonly [number, number] | null;
  before: SopsComment[];
  /** The mapping key, or null for a sequence item. */
  key: string | null;
  /** The converted value (comments are inserted at assembly). */
  value: SopsNode;
};

type Comment = { offset: number; line: number; indent: number; value: string };

function comment(value: string, inline: boolean): SopsComment {
  return { kind: "comment", value, inline };
}

/** Every `#` comment in `text` outside the protected (scalar) ranges. */
function scanComments(
  text: string,
  protectedRanges: readonly (readonly [number, number])[],
): Comment[] {
  const ranges = [...protectedRanges].sort((a, b) => a[0] - b[0]);
  const inside = (offset: number): boolean =>
    ranges.some((range) => range[0] <= offset && offset < range[1]);
  const out: Comment[] = [];
  let line = 0;
  let lineStart = 0;
  for (;;) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    for (let column = lineStart; column < lineEnd; column += 1) {
      if (text.charAt(column) !== "#") continue;
      if (column !== lineStart && !/\s/u.test(text.charAt(column - 1)))
        continue;
      if (inside(column)) continue;
      out.push({
        offset: column,
        line,
        indent: column - lineStart,
        value: text.slice(column + 1, lineEnd).replace(/\r$/u, ""),
      });
      break;
    }
    if (newline === -1) return out;
    lineStart = newline + 1;
    line += 1;
  }
}

function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charAt(index) === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineOf(lineStarts: readonly number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}

function ancestors(collection: ScanCollection): ScanCollection[] {
  const chain: ScanCollection[] = [];
  for (
    let current: ScanCollection | null = collection;
    current;
    current = current.parent
  ) {
    chain.unshift(current);
  }
  return chain;
}

/** The item of `collection` that is or contains `item`. */
function itemAtLevel(item: ScanItem, collection: ScanCollection): ScanItem {
  let current = item;
  while (current.collection !== collection) {
    const parent = current.collection.parent;
    const owner = parent?.items.find(
      (candidate) => candidate.child === current.collection,
    );
    if (!owner) return current;
    current = owner;
  }
  return current;
}

function deepestWithin(
  chain: readonly ScanCollection[],
  indent: number,
): ScanCollection | null {
  let target: ScanCollection | null = null;
  for (const candidate of chain)
    if (candidate.indent <= indent) target = candidate;
  return target;
}

function attachOwnLine(
  entry: Comment,
  prev: ScanItem | null,
  next: ScanItem | null,
  root: ScanCollection,
): void {
  const value = comment(entry.value, false);
  const prevChain = prev ? ancestors(prev.collection) : [];
  if (!next) {
    const chain = prev ? prevChain : [root];
    (deepestWithin(chain, entry.indent) ?? chain[0] ?? root).foot.push(value);
    return;
  }
  const nextChain = ancestors(next.collection);
  const opened = nextChain.filter(
    (candidate) =>
      candidate.items[0] === itemAtLevel(next, candidate) &&
      !prevChain.includes(candidate),
  );
  if (opened.length > 0) {
    const target = deepestWithin(opened, entry.indent) ?? opened[0] ?? root;
    itemAtLevel(next, target).before.push(value);
    return;
  }
  // next sits in one of prev's collections: the deepest of them at or
  // above the comment's indentation, never shallower than next's own.
  const lca = next.collection;
  const eligible = prevChain.slice(prevChain.indexOf(lca));
  const target = deepestWithin(eligible, entry.indent) ?? lca;
  if (target === lca) itemAtLevel(next, lca).before.push(value);
  else target.foot.push(value);
}

function flowClosedBefore(
  item: ScanItem,
  offset: number,
): ScanCollection | null {
  let outermost: ScanCollection | null = null;
  for (
    let current: ScanCollection | null = item.collection;
    current?.flowRange;
    current = current.parent
  ) {
    if (current.flowRange[1] <= offset) outermost = current;
    else break;
  }
  if (item.child?.flowRange && item.child.flowRange[1] <= offset)
    outermost = outermost ?? item.child;
  return outermost;
}

function attachSameLine(
  entry: Comment,
  prev: ScanItem,
  root: ScanCollection,
): void {
  const closed = flowClosedBefore(prev, entry.offset);
  if (closed) {
    const first = closed.items[0];
    if (first) first.before.push(comment(entry.value, false));
    else closed.foot.push(comment(entry.value, false));
    return;
  }
  if (prev.valueRange && prev.valueRange[0] <= entry.offset) {
    // After a scalar, or on a block scalar's header line: inline.
    prev.before.push(comment(entry.value, true));
    return;
  }
  if (prev.child && prev.collection.kind === "seq") {
    const first = prev.child.items[0];
    if (first) attachOwnLine(entry, prev, first, root);
    else prev.child.foot.push(comment(entry.value, false));
    return;
  }
  prev.before.push(comment(entry.value, false));
}

/**
 * Attach every comment of `text` to the scanned items, which are all
 * entries and sequence items in document order.
 */
export function attachComments(
  text: string,
  root: ScanCollection,
  items: readonly ScanItem[],
  protectedRanges: readonly (readonly [number, number])[],
): void {
  const lineStarts = lineStartsOf(text);
  for (const entry of scanComments(text, protectedRanges)) {
    let prev: ScanItem | null = null;
    let next: ScanItem | null = null;
    for (const item of items) {
      if (item.start < entry.offset) prev = item;
      else {
        next = item;
        break;
      }
    }
    if (prev && lineOf(lineStarts, prev.start) === entry.line) {
      attachSameLine(entry, prev, root);
      continue;
    }
    if (
      prev &&
      flowClosedBefore(prev, entry.offset) === null &&
      prev.collection.flowRange &&
      prev.collection.flowRange[1] > entry.offset
    ) {
      // An own-line comment inside a flow collection after an item.
      prev.before.push(comment(entry.value, true));
      continue;
    }
    attachOwnLine(entry, prev, next, root);
  }
}
