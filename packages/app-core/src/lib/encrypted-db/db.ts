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

import { type BoundaryValue, isString } from "@opensesame/os-domain";
import { atRestReady } from "../at-rest/key.js";
import { assertInDomain, rowEntries } from "./entries.js";
import {
  STORE,
  deleteDatabase,
  finished,
  openDatabase,
  request,
} from "./idb.js";
import { deriveEdbKeys } from "./keys.js";
import { type Context, dropLayer, ensureReady, readMeta } from "./layers.js";
import { MetaStore, layerKey, livePlans } from "./meta.js";
import { EdbQueryError, type FindOptions, type Where } from "./query.js";
import { openRow, sealRow } from "./rows.js";
import type { EdbRow, Layer, LayerPlan, Schema } from "./schema.js";
import { countRows, findRows, scanTable, storedSeal } from "./search.js";

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

  async all(table: string): Promise<EdbRow[]> {
    this.ctx.schema.keyOf(table);
    return (await scanTable(this.ctx, table)).map((opened) => opened.row);
  }

  find(table: string, where?: Where, options?: FindOptions): Promise<EdbRow[]> {
    return findRows(this.ctx, table, where, options);
  }

  count(table: string, where?: Where): Promise<number> {
    return countRows(this.ctx, table, where);
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
