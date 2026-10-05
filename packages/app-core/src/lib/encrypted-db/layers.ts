/**
 * Building and dropping a layer (ADR 0173): CryptDB's onion, peeled on
 * demand, run where the keys already are.
 *
 * A layer is built the first time a query needs it: its state is recorded
 * `building` (so every write indexes it from then on), each row is opened,
 * given the entries the layer defines and written back with the same seal,
 * and the state becomes `ready`. A tab that dies midway leaves `building`;
 * the next query finishes it. Dropping a layer is the inverse and, unlike an
 * onion in a server's database, complete: every entry for it is removed, so
 * a column that is no longer searched stops showing what it showed.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { rowEntries } from "./entries.js";
import { STORE, finished, request, slotOf } from "./idb.js";
import type { EdbKeys } from "./keys.js";
import {
  type Meta,
  type MetaStore,
  isReady,
  layerKey,
  livePlans,
  retire,
} from "./meta.js";
import { openRow } from "./rows.js";
import type { LayerPlan, Schema } from "./schema.js";

export type Context = Readonly<{
  db: IDBDatabase;
  keys: EdbKeys;
  schema: Schema;
  meta: MetaStore;
}>;

/** Rows rewritten per transaction: long enough to be cheap, short enough to yield. */
const CHUNK = 64;

/** Builds in flight in this document, so two queries build a layer once. */
const building = new Map<string, Promise<void>>();

export async function readMeta(ctx: Context): Promise<Meta> {
  const tx = ctx.db.transaction(STORE, "readonly");
  return ctx.meta.read(tx.objectStore(STORE));
}

async function mutateMeta(
  ctx: Context,
  change: (meta: Meta) => void,
): Promise<Meta> {
  const tx = ctx.db.transaction(STORE, "readwrite");
  const done = finished(tx);
  const store = tx.objectStore(STORE);
  const meta = await ctx.meta.read(store);
  change(meta);
  await ctx.meta.write(store, meta);
  await done;
  return meta;
}

/** Give every row of `table` the entries of the layers that are live now. */
async function reindex(ctx: Context, table: string): Promise<void> {
  const ids: IDBValidKey[] = await request(
    ctx.db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys(),
  );
  const slots = ids
    .map(slotOf)
    .filter((id): id is string => id !== undefined && id !== ctx.keys.metaId);
  for (let start = 0; start < slots.length; start += CHUNK) {
    const tx = ctx.db.transaction(STORE, "readwrite");
    const done = finished(tx);
    const store = tx.objectStore(STORE);
    const plans = livePlans(
      await ctx.meta.read(store),
      ctx.schema.layersOf(table),
    );
    for (const slot of slots.slice(start, start + CHUNK)) {
      const stored: BoundaryValue = await request(store.get(slot));
      if (!isJsonObject(stored) || !isString(stored.c)) continue;
      const opened = openRow(ctx.keys, slot, stored.c);
      if (opened === null || opened.table !== table) continue;
      const x = rowEntries(ctx.keys, plans, opened.row);
      await request(store.put({ c: stored.c, x }, slot));
    }
    await done;
  }
}

async function buildTable(
  ctx: Context,
  table: string,
  plans: readonly LayerPlan[],
): Promise<void> {
  await mutateMeta(ctx, (meta) => {
    for (const plan of plans) {
      retire(meta, plan);
      meta.layers[layerKey(plan)] ??= "building";
    }
  });
  await reindex(ctx, table);
  await mutateMeta(ctx, (meta) => {
    for (const plan of plans) {
      if (meta.layers[layerKey(plan)] !== undefined) {
        meta.layers[layerKey(plan)] = "ready";
      }
    }
  });
}

/** Make every plan's layer `ready`, building the ones that are not. */
export async function ensureReady(
  ctx: Context,
  plans: readonly LayerPlan[],
): Promise<void> {
  if (plans.length === 0) return;
  const meta = await readMeta(ctx);
  const missing = plans.filter((plan) => !isReady(meta, plan));
  const byTable = new Map<string, LayerPlan[]>();
  for (const plan of missing) {
    byTable.set(plan.table, [...(byTable.get(plan.table) ?? []), plan]);
  }
  for (const [table, group] of byTable) {
    const id = `${ctx.keys.databaseName}\u0000${group.map(layerKey).join("\u0001")}`;
    let run = building.get(id);
    if (!run) {
      run = buildTable(ctx, table, group).finally(() => building.delete(id));
      building.set(id, run);
    }
    await run;
  }
}

/** Remove a layer and every entry it put in the index. */
export async function dropLayer(ctx: Context, plan: LayerPlan): Promise<void> {
  await mutateMeta(ctx, (current) => {
    for (const key of Object.keys(current.layers)) {
      if (
        key.startsWith(
          `${plan.table}\u0000${plan.column}\u0000${plan.layer}\u0000`,
        )
      ) {
        delete current.layers[key];
      }
    }
  });
  await reindex(ctx, plan.table);
}
