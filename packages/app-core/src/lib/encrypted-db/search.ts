/**
 * Answering a query (ADR 0175): pick the predicate with the fewest index
 * entries, open only the rows it names, and test every predicate again on
 * what was opened. An ordered page walks the order column's own range.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { orderOffset, orderRange } from "./entries.js";
import { INDEX, STORE, betweenEntries, request, slotOf, walk } from "./idb.js";
import { type Context, ensureReady } from "./layers.js";
import {
  type Compiled,
  EdbQueryError,
  type FindOptions,
  type Where,
  compileWhere,
} from "./query.js";
import { type OpenedRow, openRow } from "./rows.js";
import type { EdbRow, LayerPlan } from "./schema.js";

export function storedSeal(stored: BoundaryValue): string | undefined {
  return isJsonObject(stored) && isString(stored.c) ? stored.c : undefined;
}

/** A row's smallest order offset in a column, or undefined when it has none. */
function offsetOfRow(plan: LayerPlan, row: EdbRow): bigint | undefined {
  const value = row[plan.column];
  const list = Array.isArray(value) ? value : [value];
  const offsets = list
    .map((element) =>
      element === undefined ? undefined : orderOffset(plan, element),
    )
    .filter((offset): offset is bigint => offset !== undefined);
  return offsets.length === 0
    ? undefined
    : offsets.reduce((low, next) => (next < low ? next : low));
}

function compareOffsets(plan: LayerPlan, a: EdbRow, b: EdbRow): number {
  const left = offsetOfRow(plan, a);
  const right = offsetOfRow(plan, b);
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Rows of `table` met by a cursor, each opened and tested. */
async function collect(
  ctx: Context,
  req: IDBRequest<IDBCursorWithValue | null>,
  table: string,
  tests: readonly Compiled[],
  limit: number,
): Promise<OpenedRow[]> {
  const seen = new Set<string>();
  const out: OpenedRow[] = [];
  await walk(req, (cursor) => {
    const slot = slotOf(cursor.primaryKey);
    if (slot === undefined || slot === ctx.keys.metaId) return true;
    if (seen.has(slot)) return true;
    seen.add(slot);
    const sealed = storedSeal(cursor.value);
    const opened =
      sealed === undefined ? null : openRow(ctx.keys, slot, sealed);
    if (
      opened !== null &&
      opened.table === table &&
      tests.every((test) => test.matches(opened.row))
    ) {
      out.push(opened);
    }
    return out.length < limit;
  });
  return out;
}

const objectStore = (ctx: Context) =>
  ctx.db.transaction(STORE, "readonly").objectStore(STORE);

const indexOf = (ctx: Context) => objectStore(ctx).index(INDEX);

/** Every row of a table, opened one at a time. */
export async function scanTable(
  ctx: Context,
  table: string,
  limit = Number.POSITIVE_INFINITY,
): Promise<OpenedRow[]> {
  return collect(ctx, objectStore(ctx).openCursor(), table, [], limit);
}

function orderPlanOf(
  ctx: Context,
  table: string,
  options: FindOptions,
): LayerPlan | undefined {
  if (!options.order) return undefined;
  const plan = ctx.schema.layer(table, options.order.column, "order");
  if (!plan) {
    throw new EdbQueryError(
      `${table}.${options.order.column} has no order layer`,
    );
  }
  return plan;
}

/**
 * Walk the order column's own range, so a page of the latest rows opens that
 * many rows and no more.
 */
function streamed(
  ctx: Context,
  table: string,
  tests: readonly Compiled[],
  plan: LayerPlan,
  options: FindOptions,
  limit: number,
): Promise<OpenedRow[]> {
  const [from, to] = orderRange(ctx.keys, plan, undefined, undefined);
  const driver = tests.find((test) => test.plan === plan);
  const direction = options.order?.direction === "desc" ? "prev" : "next";
  const range = driver?.range ?? betweenEntries(from, to);
  return collect(
    ctx,
    indexOf(ctx).openCursor(range, direction),
    table,
    tests,
    limit,
  );
}

/** Find candidates by the predicate with the fewest entries, or scan. */
async function driven(
  ctx: Context,
  table: string,
  tests: readonly Compiled[],
  limit: number,
): Promise<OpenedRow[]> {
  if (tests.length === 0) return scanTable(ctx, table, limit);
  const index = indexOf(ctx);
  const counts = await Promise.all(
    tests.map((test) => request(index.count(test.range ?? undefined))),
  );
  const best = counts.indexOf(Math.min(...counts));
  const driver = tests[best];
  if (driver === undefined || counts[best] === 0) return [];
  return collect(
    ctx,
    index.openCursor(driver.range ?? undefined),
    table,
    tests,
    limit,
  );
}

export async function findRows(
  ctx: Context,
  table: string,
  where: Where = {},
  options: FindOptions = {},
): Promise<EdbRow[]> {
  const tests = compileWhere(ctx.keys, ctx.schema, table, where);
  const orderPlan = orderPlanOf(ctx, table, options);
  await ensureReady(ctx, [
    ...tests.map((test) => test.plan),
    ...(orderPlan ? [orderPlan] : []),
  ]);
  if (tests.some((test) => test.range === null)) return [];
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  if (orderPlan === undefined) {
    const rows = await driven(ctx, table, tests, limit);
    return rows.map((opened) => opened.row);
  }
  // An order walk drives itself when a predicate bounds the column, or when
  // nothing else does.
  if (tests.length === 0 || tests.some((test) => test.plan === orderPlan)) {
    const rows = await streamed(ctx, table, tests, orderPlan, options, limit);
    return rows.map((opened) => opened.row);
  }
  const found = (await driven(ctx, table, tests, Number.POSITIVE_INFINITY)).map(
    (opened) => opened.row,
  );
  const sign = options.order?.direction === "desc" ? -1 : 1;
  found.sort((a, b) => sign * compareOffsets(orderPlan, a, b));
  return found.slice(0, limit);
}

/** The number of rows a `where` meets: from the index when it is exact. */
export async function countRows(
  ctx: Context,
  table: string,
  where: Where = {},
): Promise<number> {
  const tests = compileWhere(ctx.keys, ctx.schema, table, where);
  const [only] = tests;
  if (tests.length === 1 && only?.exact === true) {
    await ensureReady(ctx, [only.plan]);
    if (only.range === null) return 0;
    return request(indexOf(ctx).count(only.range));
  }
  return (await findRows(ctx, table, where)).length;
}
