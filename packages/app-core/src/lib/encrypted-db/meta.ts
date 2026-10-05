/**
 * Which layers of which columns are built (ADR 0173).
 *
 * A layer is dormant until a query needs it: the column then sits sealed
 * with no entry for it on disk, and a reader of the disk learns nothing from
 * it. The record that says what is built is itself a sealed row, so even
 * which columns have ever been searched is unreadable without the key.
 *
 * A layer is `building` from the moment its first entry is written until
 * every row has been indexed, then `ready`. A write indexes a `building`
 * layer already, so no row falls between the backfill and the live path; a
 * query waits for `ready`.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { request } from "./idb.js";
import type { EdbKeys } from "./keys.js";
import { openSealed, sealPadded } from "./rows.js";
import type { LayerPlan } from "./schema.js";

export type LayerState = "building" | "ready";
export type Meta = { layers: Record<string, LayerState> };

export const layerKey = (plan: LayerPlan): string =>
  `${plan.table}\u0000${plan.column}\u0000${plan.id}`;

/** Every state a column's layer of this kind has ever had, whatever its settings. */
const family = (plan: LayerPlan): string =>
  `${plan.table}\u0000${plan.column}\u0000${plan.layer}\u0000`;

export function isLive(meta: Meta, plan: LayerPlan): boolean {
  return meta.layers[layerKey(plan)] !== undefined;
}

export function isReady(meta: Meta, plan: LayerPlan): boolean {
  return meta.layers[layerKey(plan)] === "ready";
}

/** The plans whose entries a write must keep up. */
export function livePlans(
  meta: Meta,
  plans: readonly LayerPlan[],
): LayerPlan[] {
  return plans.filter((plan) => isLive(meta, plan));
}

/** Forget layers of the same column and kind that were built with other settings. */
export function retire(meta: Meta, plan: LayerPlan): void {
  const keep = layerKey(plan);
  for (const key of Object.keys(meta.layers)) {
    if (key !== keep && key.startsWith(family(plan))) delete meta.layers[key];
  }
}

function parse(body: BoundaryValue): Meta {
  const layers: Record<string, LayerState> = {};
  if (isJsonObject(body) && isJsonObject(body.layers)) {
    for (const [key, state] of Object.entries(body.layers)) {
      if (state === "building" || state === "ready") layers[key] = state;
    }
  }
  return { layers };
}

/** Reads and writes the sealed state record, re-opening it only when it changed. */
export class MetaStore {
  private cached: { sealed: string; meta: Meta } | null = null;

  constructor(private readonly keys: EdbKeys) {}

  async read(store: IDBObjectStore): Promise<Meta> {
    const stored: BoundaryValue = await request(store.get(this.keys.metaId));
    if (!isJsonObject(stored) || !isString(stored.c)) {
      return { layers: {} };
    }
    if (this.cached?.sealed === stored.c) {
      return { layers: { ...this.cached.meta.layers } };
    }
    const meta = parse(openSealed(this.keys, this.keys.metaId, stored.c));
    this.cached = { sealed: stored.c, meta };
    return { layers: { ...meta.layers } };
  }

  async write(store: IDBObjectStore, meta: Meta): Promise<void> {
    const sealed = sealPadded(
      this.keys,
      this.keys.metaId,
      JSON.stringify({ v: 1, layers: meta.layers }),
    );
    await request(store.put({ c: sealed, x: [] }, this.keys.metaId));
    this.cached = { sealed, meta: { layers: { ...meta.layers } } };
  }
}
