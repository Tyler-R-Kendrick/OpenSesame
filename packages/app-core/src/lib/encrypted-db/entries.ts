/**
 * The index entries a row gets, and the ones a query looks for (ADR 0175).
 *
 * Every entry of every column of every table goes into one index, and the
 * entries are indistinguishable by shape: a 128-bit hex string for an
 * equality, word or prefix token, a `[tag, hex]` pair for an order key. What
 * the index shows a reader of the disk is how many entries each row has and
 * which rows share one - not which column or table either belongs to.
 */

import { isBoolean, isNumber, isString } from "@opensesame/os-domain";
import type { EdbKeys } from "./keys.js";
import { opeHex, opeHexBounds } from "./ope.js";
import {
  type EdbRow,
  type EdbValue,
  type LayerPlan,
  PREFIX_MAX,
} from "./schema.js";

export type IndexKey = string | [string, string];

/** A value a column can be matched on; arrays match on any element. */
export function elementsOf(value: EdbValue | undefined): EdbValue[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** A primitive in a form no two distinct values share. */
export function canonical(value: EdbValue): string | undefined {
  if (isString(value)) return `s:${value}`;
  if (isNumber(value)) {
    return Number.isFinite(value)
      ? `n:${Object.is(value, -0) ? 0 : value}`
      : undefined;
  }
  if (isBoolean(value)) return `b:${value}`;
  return value === null ? "z:" : undefined;
}

/** Lowercased words of a text: letters and digits, whatever the script. */
export function wordsOf(text: string): string[] {
  const words = text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
  return [...new Set(words)].slice(0, 256);
}

/** The prefixes of a word that are indexed, from `min` characters up. */
export function prefixesOf(word: string, min: number): string[] {
  const chars = [...word];
  const out: string[] = [];
  for (let n = Math.max(min, 1); n <= Math.min(chars.length, PREFIX_MAX); n++) {
    out.push(chars.slice(0, n).join(""));
  }
  return out;
}

/** An order key's offset into its domain, or undefined when it has none. */
export function orderOffset(
  plan: LayerPlan,
  value: EdbValue,
): bigint | undefined {
  let n: number;
  if (isNumber(value)) n = value;
  else if (isString(value) && plan.time) {
    n = Date.parse(value);
  } else return undefined;
  if (!Number.isSafeInteger(n)) return undefined;
  const offset = BigInt(n) - plan.origin;
  return offset >= 0n && offset < plan.domain ? offset : undefined;
}

export function orderEntry(
  keys: EdbKeys,
  plan: LayerPlan,
  offset: bigint,
): [string, string] {
  const key = keys.opeKey(plan.table, plan.column, plan.domain);
  return [
    keys.columnTag(plan.table, plan.column),
    opeHex(key, plan.domain, offset),
  ];
}

function orderEntries(
  keys: EdbKeys,
  plan: LayerPlan,
  element: EdbValue,
): IndexKey[] {
  // An absent value has no place in an order, and is found by no range.
  if (element === null) return [];
  const offset = orderOffset(plan, element);
  if (offset === undefined) {
    throw new RangeError(
      `${plan.table}.${plan.column} holds a value outside its order domain`,
    );
  }
  return [orderEntry(keys, plan, offset)];
}

function keywordEntries(
  keys: EdbKeys,
  plan: LayerPlan,
  element: EdbValue,
): IndexKey[] {
  if (!isString(element)) return [];
  return wordsOf(element).flatMap((word) => [
    wordToken(keys, plan, word),
    ...(plan.prefix > 0 ? prefixesOf(word, plan.prefix) : []).map((prefix) =>
      prefixToken(keys, plan, prefix),
    ),
  ]);
}

function equalityEntries(
  keys: EdbKeys,
  plan: LayerPlan,
  element: EdbValue,
): IndexKey[] {
  const form = canonical(element);
  return form === undefined ? [] : [keys.token("eq", plan.scope, form)];
}

/** The entries one column of a row has under one layer. */
export function columnEntries(
  keys: EdbKeys,
  plan: LayerPlan,
  value: EdbValue | undefined,
): IndexKey[] {
  const make =
    plan.layer === "eq"
      ? equalityEntries
      : plan.layer === "order"
        ? orderEntries
        : keywordEntries;
  return elementsOf(value).flatMap((element) => make(keys, plan, element));
}

const scopeOf = (plan: LayerPlan): string =>
  `c:${plan.table}\u0000${plan.column}`;

export function wordToken(
  keys: EdbKeys,
  plan: LayerPlan,
  word: string,
): string {
  return keys.token("kw", scopeOf(plan), word);
}

export function prefixToken(
  keys: EdbKeys,
  plan: LayerPlan,
  prefix: string,
): string {
  return keys.token("px", scopeOf(plan), prefix);
}

/**
 * Refuse a row an order layer could never index. Checked for every declared
 * layer, built or not, so a layer built later cannot fail on rows already
 * written.
 */
export function assertInDomain(plans: readonly LayerPlan[], row: EdbRow): void {
  for (const plan of plans) {
    if (plan.layer !== "order") continue;
    for (const element of elementsOf(row[plan.column])) {
      if (element !== null && orderOffset(plan, element) === undefined) {
        throw new RangeError(
          `${plan.table}.${plan.column} holds a value outside its order domain`,
        );
      }
    }
  }
}

/** Every entry a row has under the layers that are live, without repeats. */
export function rowEntries(
  keys: EdbKeys,
  plans: readonly LayerPlan[],
  row: EdbRow,
): IndexKey[] {
  const seen = new Set<string>();
  const out: IndexKey[] = [];
  for (const plan of plans) {
    for (const entry of columnEntries(keys, plan, row[plan.column])) {
      const id = isString(entry) ? entry : `${entry[0]}|${entry[1]}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(entry);
    }
  }
  return out;
}

/** The inclusive index range of an order query, ends open when omitted. */
export function orderRange(
  keys: EdbKeys,
  plan: LayerPlan,
  low: bigint | undefined,
  high: bigint | undefined,
): [[string, string], [string, string]] {
  const tag = keys.columnTag(plan.table, plan.column);
  const [floor, ceiling] = opeHexBounds(plan.domain);
  const key = keys.opeKey(plan.table, plan.column, plan.domain);
  return [
    [tag, low === undefined ? floor : opeHex(key, plan.domain, low)],
    [tag, high === undefined ? ceiling : opeHex(key, plan.domain, high)],
  ];
}
