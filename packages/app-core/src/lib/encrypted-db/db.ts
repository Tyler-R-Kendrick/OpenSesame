/**
 * An encrypted database (ADR 0173): rows that are never on disk in the
 * clear, found by what is in them without being opened.
 *
 * Everything the application's data model says - a table, a key, a field,
 * a user's id - is inside the seal or behind a keyed hash. What a reader of
 * the browser's profile sees is one object store of random-looking keys, one
 * index of random-looking entries, and a count of each. A query is answered
 * by looking entries up, opening only the rows they name, and testing every
 * predicate again on what was opened.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { atRestReady } from "../at-rest/key.js";
import {
  assertInDomain,
  orderOffset,
  orderRange,
  rowEntries,
} from "./entries.js";
import {
  INDEX,
  STORE,
  betweenEntries,
  deleteDatabase,
  finished,
  openDatabase,
  request,
  slotOf,
  walk,
} from "./idb.js";
import { deriveEdbKeys } from "./keys.js";
import { type Context, dropLayer, ensureReady, readMeta } from "./layers.js";
import { MetaStore, layerKey, livePlans } from "./meta.js";
import {
  type Compiled,
  EdbQueryError,
  type FindOptions,
  type Where,
  compileWhere,
} from "./query.js";
import { type OpenedRow, openRow, sealRow } from "./rows.js";
import type { EdbRow, Layer, LayerPlan, Schema } from "./schema.js";

export class EncryptedDbUnavailable extends Error {
  constructor(reason: string) {
    super(`encrypted database unavailable: ${reason}`);
    this.name = "EncryptedDbUnavailable";
  }
}

export type LayerReport = Readonly<{
  table: string;
  column: string;
  layer: Layer;
  state: "dormant" | "building" | "ready";
}>;

export type EncryptedDb = Readonly<{
  /** What the browser lists this database as. */
  name: string;
  put: (table: string, row: EdbRow) => Promise<void>;
  get: (table: string, key: string) => Promise<EdbRow | undefined>;
  delete: (table: string, key: string) => Promise<void>;
  /** Every row of a table, opened one at a time. */
  all: (table: string) => Promise<EdbRow[]>;
  find: (
    table: string,
    where?: Where,
    options?: FindOptions,
  ) => Promise<EdbRow[]>;
  count: (table: string, where?: Where) => Promise<number>;
  /** Rows of every table; the layer-state record is not one. */
  size: () => Promise<number>;
  layers: () => Promise<LayerReport[]>;
  /** Build a layer now rather than at the first query that needs it. */
  build: (table: string, column: string, layer: Layer) => Promise<void>;
  /** Remove a layer and every entry it left on disk. */
  drop: (table: string, column: string, layer: Layer) => Promise<void>;
  close: () => void;
  /** Close and delete the database. */
  destroy: () => Promise<void>;
}>;

function storedSeal(stored: BoundaryValue): string | undefined {
  return isJsonObject(stored) && isString(stored.c) ? stored.c : undefined;
}

function compareOffsets(plan: LayerPlan, a: EdbRow, b: EdbRow): number {
  const offsetOf = (row: EdbRow): bigint | undefined => {
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
  };
  const left = offsetOf(a);
  const right = offsetOf(b);
  if (left === undefined || right === undefined) {
    return left === right ? 0 : left === undefined ? 1 : -1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

class Database {
  constructor(private readonly ctx: Context) {}

  get name(): string {
    return this.ctx.keys.databaseName;
  }

  private tableKey(table: string, row: EdbRow): string {
    const key = row[this.ctx.schema.keyOf(table)];
    if (!isString(key) || key === "") {
      throw new EdbQueryError(`${table} rows need a non-empty string key`);
    }
    return key;
  }

  async put(table: string, row: EdbRow): Promise<void> {
    const { db, keys, schema, meta } = this.ctx;
    const key = this.tableKey(table, row);
    assertInDomain(schema.layersOf(table), row);
    const tx = db.transaction(STORE, "readwrite");
    const done = finished(tx);
    const store = tx.objectStore(STORE);
    const plans = livePlans(await meta.read(store), schema.layersOf(table));
    const x = rowEntries(keys, plans, row);
    const c = sealRow(keys, table, key, row);
    await request(store.put({ c, x }, keys.rowId(table, key)));
    await done;
  }

  async get(table: string, key: string): Promise<EdbRow | undefined> {
    const { db, keys } = this.ctx;
    this.ctx.schema.keyOf(table);
    const slot = keys.rowId(table, key);
    const stored: BoundaryValue = await request(
      db.transaction(STORE, "readonly").objectStore(STORE).get(slot),
    );
    const sealed = storedSeal(stored);
    const opened = sealed === undefined ? null : openRow(keys, slot, sealed);
    return opened?.table === table && opened.key === key
      ? opened.row
      : undefined;
  }

  async delete(table: string, key: string): Promise<void> {
    const { db, keys } = this.ctx;
    this.ctx.schema.keyOf(table);
    const tx = db.transaction(STORE, "readwrite");
    const done = finished(tx);
    await request(tx.objectStore(STORE).delete(keys.rowId(table, key)));
    await done;
  }

  /** Rows of `table` met by a cursor, each opened and tested. */
  private async collect(
    req: IDBRequest<IDBCursorWithValue | null>,
    table: string,
    tests: readonly Compiled[],
    limit: number,
  ): Promise<OpenedRow[]> {
    const { keys } = this.ctx;
    const seen = new Set<string>();
    const out: OpenedRow[] = [];
    await walk(req, (cursor) => {
      const slot = slotOf(cursor.primaryKey);
      if (slot === undefined || slot === keys.metaId) return true;
      if (seen.has(slot)) return true;
      seen.add(slot);
      const sealed = storedSeal(cursor.value);
      const opened = sealed === undefined ? null : openRow(keys, slot, sealed);
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

  async all(table: string): Promise<EdbRow[]> {
    this.ctx.schema.keyOf(table);
    const store = this.ctx.db.transaction(STORE, "readonly").objectStore(STORE);
    const rows = await this.collect(
      store.openCursor(),
      table,
      [],
      Number.POSITIVE_INFINITY,
    );
    return rows.map((opened) => opened.row);
  }

  async find(
    table: string,
    where: Where = {},
    options: FindOptions = {},
  ): Promise<EdbRow[]> {
    const { db, keys, schema } = this.ctx;
    const tests = compileWhere(keys, schema, table, where);
    const order = options.order;
    let orderPlan: LayerPlan | undefined;
    if (order) {
      orderPlan = schema.layer(table, order.column, "order");
      if (!orderPlan) {
        throw new EdbQueryError(`${table}.${order.column} has no order layer`);
      }
    }
    await ensureReady(this.ctx, [
      ...tests.map((test) => test.plan),
      ...(orderPlan ? [orderPlan] : []),
    ]);
    if (tests.some((test) => test.range === null)) return [];
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    const index = db
      .transaction(STORE, "readonly")
      .objectStore(STORE)
      .index(INDEX);
    const direction = order?.direction === "desc" ? "prev" : "next";

    // Streaming: walk the order column's own range, so a page of the latest
    // rows opens that many rows and no more.
    if (orderPlan) {
      const driver = tests.find((test) => test.plan === orderPlan);
      if (driver !== undefined || tests.length === 0) {
        const [from, to] = orderRange(keys, orderPlan, undefined, undefined);
        const range = driver?.range ?? betweenEntries(from, to);
        const rows = await this.collect(
          index.openCursor(range, direction),
          table,
          tests,
          limit,
        );
        return rows.map((opened) => opened.row);
      }
    }

    let rows: OpenedRow[];
    if (tests.length === 0) {
      const store = db.transaction(STORE, "readonly").objectStore(STORE);
      rows = await this.collect(
        store.openCursor(),
        table,
        [],
        orderPlan ? Number.POSITIVE_INFINITY : limit,
      );
    } else {
      const counts = await Promise.all(
        tests.map((test) => request(index.count(test.range ?? undefined))),
      );
      const best = counts.indexOf(Math.min(...counts));
      const driver = tests[best];
      if (counts[best] === 0 || driver === undefined) return [];
      rows = await this.collect(
        index.openCursor(driver.range ?? undefined),
        table,
        tests,
        orderPlan ? Number.POSITIVE_INFINITY : limit,
      );
    }
    const found = rows.map((opened) => opened.row);
    if (orderPlan && order) {
      const plan = orderPlan;
      const sign = order.direction === "desc" ? -1 : 1;
      found.sort((a, b) => sign * compareOffsets(plan, a, b));
    }
    return found.slice(0, limit);
  }

  async count(table: string, where: Where = {}): Promise<number> {
    const { db, keys, schema } = this.ctx;
    const tests = compileWhere(keys, schema, table, where);
    const [only] = tests;
    if (tests.length === 1 && only?.exact === true) {
      await ensureReady(this.ctx, [only.plan]);
      if (only.range === null) return 0;
      const index = db
        .transaction(STORE, "readonly")
        .objectStore(STORE)
        .index(INDEX);
      return request(index.count(only.range));
    }
    return (await this.find(table, where)).length;
  }

  async size(): Promise<number> {
    const store = this.ctx.db.transaction(STORE, "readonly").objectStore(STORE);
    const total = await request(store.count());
    const held = await request(store.count(this.ctx.keys.metaId));
    return total - held;
  }

  async layers(): Promise<LayerReport[]> {
    const meta = await readMeta(this.ctx);
    const out: LayerReport[] = [];
    for (const table of this.ctx.schema.tables) {
      for (const plan of this.ctx.schema.layersOf(table)) {
        out.push({
          table,
          column: plan.column,
          layer: plan.layer,
          state: meta.layers[layerKey(plan)] ?? "dormant",
        });
      }
    }
    return out;
  }

  private planOf(table: string, column: string, layer: Layer): LayerPlan {
    const plan = this.ctx.schema.layer(table, column, layer);
    if (!plan)
      throw new EdbQueryError(`${table}.${column} has no ${layer} layer`);
    return plan;
  }

  build(table: string, column: string, layer: Layer): Promise<void> {
    return ensureReady(this.ctx, [this.planOf(table, column, layer)]);
  }

  drop(table: string, column: string, layer: Layer): Promise<void> {
    return dropLayer(this.ctx, this.planOf(table, column, layer));
  }

  close(): void {
    this.ctx.db.close();
    this.ctx.keys.wipe();
  }

  async destroy(): Promise<void> {
    const name = this.name;
    this.close();
    await deleteDatabase(name);
  }
}

/** Open the database a logical name stands for, under the device's at-rest key. */
export async function openEncryptedDb(
  logicalName: string,
  schema: Schema,
): Promise<EncryptedDb> {
  let atRest: Awaited<ReturnType<typeof atRestReady>>;
  try {
    atRest = await atRestReady();
  } catch {
    throw new EncryptedDbUnavailable("the device key could not be loaded");
  }
  // A key that dies with this document could never read back what it wrote.
  if (!atRest.durable) {
    throw new EncryptedDbUnavailable("this device keeps no durable key");
  }
  const keys = deriveEdbKeys(atRest.key, logicalName);
  let db: IDBDatabase;
  try {
    db = await openDatabase(keys.databaseName);
  } catch (error) {
    keys.wipe();
    throw new EncryptedDbUnavailable(
      error instanceof Error ? error.message : "IndexedDB did not open",
    );
  }
  const ctx: Context = { db, keys, schema, meta: new MetaStore(keys) };
  const database = new Database(ctx);
  const eager = [...schema.tables]
    .flatMap((table) => schema.layersOf(table))
    .filter((plan) => plan.eager);
  try {
    await ensureReady(ctx, eager);
  } catch (error) {
    database.close();
    throw error;
  }
  return database;
}
