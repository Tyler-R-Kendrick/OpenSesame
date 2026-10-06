/**
 * A `where` clause, compiled (ADR 0175).
 *
 * Each predicate becomes two things: the index range that finds candidate
 * rows without opening them, and the exact test the opened row must pass.
 * The index only ever narrows; the test decides. So a prefix longer than
 * the longest indexed one, a token shared by a join group, or an exclusive
 * bound can never put a wrong row in an answer.
 */

import { isNumber, isString, isTypeofObject } from "@opensesame/os-domain";
import {
  canonical,
  elementsOf,
  orderOffset,
  orderRange,
  prefixToken,
  wordToken,
  wordsOf,
} from "./entries.js";
import { betweenEntries, onlyEntry } from "./idb.js";
import type { EdbKeys } from "./keys.js";
import {
  type EdbRow,
  type EdbValue,
  type Layer,
  type LayerPlan,
  PREFIX_MAX,
  type Schema,
} from "./schema.js";

export type Predicate =
  | string
  | number
  | boolean
  | null
  | Readonly<{
      gt?: number | string;
      gte?: number | string;
      lt?: number | string;
      lte?: number | string;
    }>
  | Readonly<{ word: string }>
  | Readonly<{ prefix: string }>;

export type Where = Readonly<Record<string, Predicate>>;

export type FindOptions = Readonly<{
  /** Sort by an `order` column; without one, rows come in no stated order. */
  order?: Readonly<{ column: string; direction?: "asc" | "desc" }>;
  limit?: number;
}>;

export type Compiled = Readonly<{
  plan: LayerPlan;
  /** The index range holding every row the predicate can match; none if it cannot match. */
  range: IDBKeyRange | null;
  /** Whether the number of entries in `range` is the number of matching rows. */
  exact: boolean;
  matches: (row: EdbRow) => boolean;
}>;

export class EdbQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EdbQueryError";
  }
}

function planFor(
  schema: Schema,
  table: string,
  column: string,
  layer: Layer,
): LayerPlan {
  const plan = schema.layer(table, column, layer);
  if (!plan) {
    throw new EdbQueryError(`${table}.${column} has no ${layer} layer`);
  }
  return plan;
}

function isOps(
  predicate: Predicate,
): predicate is Exclude<Predicate, string | number | boolean | null> {
  return isTypeofObject(predicate) && predicate !== null;
}

function equals(
  keys: EdbKeys,
  schema: Schema,
  table: string,
  column: string,
  value: EdbValue,
): Compiled {
  const plan = planFor(schema, table, column, "eq");
  const form = canonical(value);
  if (form === undefined) {
    throw new EdbQueryError(`${table}.${column}: not a value that can match`);
  }
  const token = keys.token("eq", plan.scope, form);
  return {
    plan,
    range: onlyEntry(token),
    // A group shares one token across its columns, so the count is a bound.
    exact: plan.scope.startsWith("c:"),
    matches: (row) =>
      elementsOf(row[column]).some((element) => canonical(element) === form),
  };
}

type Bounds = Readonly<{
  gt?: number | string;
  gte?: number | string;
  lt?: number | string;
  lte?: number | string;
}>;

type Span = Readonly<{ low?: bigint; high?: bigint }>;

function isEmpty(
  low: bigint | undefined,
  high: bigint | undefined,
  last: bigint,
): boolean {
  if (low !== undefined && (low > last || (high !== undefined && low > high))) {
    return true;
  }
  return high !== undefined && high < 0n;
}

/**
 * The inclusive offsets a set of bounds comes to, or null when no value of
 * the domain can meet them. A bound beyond the domain on its open side is no
 * bound at all.
 */
function spanOf(
  plan: LayerPlan,
  bounds: Bounds,
  offsetOf: (value: number | string, round: (n: number) => number) => bigint,
): Span | null {
  let low: bigint | undefined;
  let high: bigint | undefined;
  const raise = (to: bigint) => {
    low = low === undefined || to > low ? to : low;
  };
  const lower = (to: bigint) => {
    high = high === undefined || to < high ? to : high;
  };
  if (bounds.gte !== undefined) raise(offsetOf(bounds.gte, Math.ceil));
  if (bounds.gt !== undefined) raise(offsetOf(bounds.gt, Math.floor) + 1n);
  if (bounds.lte !== undefined) lower(offsetOf(bounds.lte, Math.floor));
  if (bounds.lt !== undefined) lower(offsetOf(bounds.lt, Math.ceil) - 1n);
  const last = plan.domain - 1n;
  if (isEmpty(low, high, last)) return null;
  return {
    low: low !== undefined && low > 0n ? low : undefined,
    high: high !== undefined && high < last ? high : undefined,
  };
}

function between(
  keys: EdbKeys,
  schema: Schema,
  table: string,
  column: string,
  bounds: Bounds,
): Compiled {
  const plan = planFor(schema, table, column, "order");
  const offsetOf = (
    value: number | string,
    round: (n: number) => number,
  ): bigint => {
    const n = isString(value) && plan.time ? Date.parse(value) : value;
    if (!isNumber(n) || Number.isNaN(n)) {
      throw new EdbQueryError(`${table}.${column}: not an order bound`);
    }
    const safe = Math.max(
      -Number.MAX_SAFE_INTEGER,
      Math.min(Number.MAX_SAFE_INTEGER, round(n)),
    );
    return BigInt(safe) - plan.origin;
  };
  const span = spanOf(plan, bounds, offsetOf);
  if (span === null) {
    return { plan, range: null, exact: true, matches: () => false };
  }
  const { low, high } = span;
  const [from, to] = orderRange(keys, plan, low, high);
  return {
    plan,
    range: betweenEntries(from, to),
    exact: true,
    matches: (row) =>
      elementsOf(row[column]).some((element) => {
        const offset = orderOffset(plan, element);
        return (
          offset !== undefined &&
          (low === undefined || offset >= low) &&
          (high === undefined || offset <= high)
        );
      }),
  };
}

function words(
  keys: EdbKeys,
  schema: Schema,
  table: string,
  column: string,
  text: string,
): Compiled[] {
  const plan = planFor(schema, table, column, "keyword");
  const wanted = wordsOf(text);
  if (wanted.length === 0) {
    throw new EdbQueryError(`${table}.${column}: no word to look for`);
  }
  return wanted.map((word) => ({
    plan,
    range: onlyEntry(wordToken(keys, plan, word)),
    exact: true,
    matches: (row) =>
      elementsOf(row[column]).some(
        (element) => isString(element) && wordsOf(element).includes(word),
      ),
  }));
}

function prefixed(
  keys: EdbKeys,
  schema: Schema,
  table: string,
  column: string,
  text: string,
): Compiled {
  const plan = planFor(schema, table, column, "keyword");
  const wanted = wordsOf(text);
  const [prefix] = wanted;
  if (plan.prefix === 0 || wanted.length !== 1 || prefix === undefined) {
    throw new EdbQueryError(
      `${table}.${column} has no prefix layer, or the prefix is not one word`,
    );
  }
  const chars = [...prefix];
  if (chars.length < plan.prefix) {
    throw new EdbQueryError(
      `${table}.${column}: a prefix is at least ${plan.prefix} characters`,
    );
  }
  const indexed = chars.slice(0, PREFIX_MAX).join("");
  return {
    plan,
    range: onlyEntry(prefixToken(keys, plan, indexed)),
    exact: chars.length <= PREFIX_MAX,
    matches: (row) =>
      elementsOf(row[column]).some(
        (element) =>
          isString(element) &&
          wordsOf(element).some((word) => word.startsWith(prefix)),
      ),
  };
}

/** The predicates of a `where`, each ready to find rows and to test them. */
export function compileWhere(
  keys: EdbKeys,
  schema: Schema,
  table: string,
  where: Where,
): Compiled[] {
  const out: Compiled[] = [];
  for (const [column, predicate] of Object.entries(where)) {
    if (!schema.columns(table).includes(column)) {
      throw new EdbQueryError(`${table} has no column ${column}`);
    }
    if (!isOps(predicate)) {
      out.push(equals(keys, schema, table, column, predicate));
    } else if ("word" in predicate) {
      out.push(...words(keys, schema, table, column, predicate.word));
    } else if ("prefix" in predicate) {
      out.push(prefixed(keys, schema, table, column, predicate.prefix));
    } else {
      out.push(between(keys, schema, table, column, predicate));
    }
  }
  return out;
}
