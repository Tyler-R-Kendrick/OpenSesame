/**
 * Durable fence snapshot helpers (AUTH-C).
 * OPFS / localStorage adapters supply get/set; BroadcastChannel is hint-only.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  overlapCast,
} from "../json-boundary.js";
import type { FenceState } from "./fence.js";

function readBrowserLocalStorage(): Storage | null {
  if (!("localStorage" in globalThis)) return null;
  return globalThis.localStorage;
}

function parseStoredFence(raw: string): FenceState | null {
  let wire: BoundaryValue;
  try {
    wire = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(wire)) return null;
  // SAFETY: FenceState JSON is written only by createLocalStorageFenceStore.set in this module.
  return overlapCast<JsonObject, FenceState>(wire);
}

export type DurableFenceStore = {
  get(): Promise<FenceState | null>;
  set(state: FenceState): Promise<void>;
  clear(): Promise<void>;
};

const FENCE_STORAGE_KEY = "opensesame.duress.fence.v1";

/** In-memory durable store for tests and environments without OPFS. */
export function createMemoryFenceStore(
  initial: FenceState | null = null,
): DurableFenceStore {
  let value = initial;
  return {
    async get() {
      return value;
    },
    async set(state) {
      value = {
        ...state,
        activeIncidentIds: [...state.activeIncidentIds],
        denyOperations: [...state.denyOperations],
        admittedCompartmentRefs: [...state.admittedCompartmentRefs],
      };
    },
    async clear() {
      value = null;
    },
  };
}

/**
 * localStorage-backed fence pointer. Crash-consistent for same-origin tabs;
 * not a tamper clock (INV-19).
 */
export function createLocalStorageFenceStore(
  storage: Storage | null = readBrowserLocalStorage(),
): DurableFenceStore {
  return {
    async get() {
      if (!storage) return null;
      const raw = storage.getItem(FENCE_STORAGE_KEY);
      if (!raw) return null;
      return parseStoredFence(raw);
    },
    async set(state) {
      if (!storage) throw new Error("undurable_storage");
      storage.setItem(FENCE_STORAGE_KEY, JSON.stringify(state));
    },
    async clear() {
      storage?.removeItem(FENCE_STORAGE_KEY);
    },
  };
}

/** Prefer durable epoch over a missed BroadcastChannel hint (AT lost broadcasts). */
export function preferDurableFence(
  memory: FenceState,
  durable: FenceState | null,
): FenceState {
  if (!durable) return memory;
  if (durable.incidentEpoch > memory.incidentEpoch) return durable;
  return memory;
}
