/**
 * Durable (in-memory + localStorage) incident fence for the browser origin.
 * BroadcastChannel is a hint only — peers must rehydrateFromDurable() before
 * protected ops (AUTH-C, INV-37). Extends ProtectionSessionGuard generation.
 */

import { ProtectionSessionGuard } from "../../vault/protection/session-guard.js";
import type { AccessContext } from "../access/context.js";
import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isNumber,
  isTypeofObject,
  overlapCast,
} from "../json-boundary.js";

export type FenceState = Readonly<{
  incidentEpoch: number;
  policyRevision: number;
  keyEpoch: number;
  activeIncidentIds: readonly string[];
  denyOperations: readonly string[];
  admittedCompartmentRefs: readonly string[];
  retiredDevice: boolean;
}>;

const FENCE_STORAGE_KEY = "opensesame.duress.fence.v1";
const FENCE_LOCK_NAME = "opensesame.duress.fence";

const emptyFence = (): FenceState => ({
  incidentEpoch: 0,
  policyRevision: 0,
  keyEpoch: 0,
  activeIncidentIds: [],
  denyOperations: [],
  admittedCompartmentRefs: [],
  retiredDevice: false,
});

function parseFence(raw: string | null): FenceState | null {
  if (!raw) return null;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return null;
    const row = parsed;
    const incidentEpoch = row.incidentEpoch;
    const policyRevision = row.policyRevision;
    const keyEpoch = row.keyEpoch;
    const activeIncidentIds = row.activeIncidentIds;
    const denyOperations = row.denyOperations;
    const admittedCompartmentRefs = row.admittedCompartmentRefs;
    if (
      !isNumber(incidentEpoch) ||
      !isNumber(policyRevision) ||
      !isNumber(keyEpoch) ||
      !Array.isArray(activeIncidentIds) ||
      !Array.isArray(denyOperations) ||
      !Array.isArray(admittedCompartmentRefs)
    ) {
      return null;
    }
    return {
      incidentEpoch,
      policyRevision,
      keyEpoch,
      activeIncidentIds: activeIncidentIds.map(String),
      denyOperations: denyOperations.map(String),
      admittedCompartmentRefs: admittedCompartmentRefs.map(String),
      retiredDevice: row.retiredDevice === true,
    };
  } catch {
    return null;
  }
}

function persistFence(state: FenceState): void {
  try {
    // ast-grep-ignore: ts-localstorage-set
    globalThis.localStorage?.setItem(FENCE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode — in-memory fence still authoritative in this tab */
  }
}

function readDurableFence(): FenceState | null {
  try {
    return parseFence(
      globalThis.localStorage?.getItem(FENCE_STORAGE_KEY) ?? null,
    );
  } catch {
    return null;
  }
}

export class DuressSessionFence {
  readonly guard = new ProtectionSessionGuard();
  #fence: FenceState = emptyFence();
  #context: AccessContext | null = null;
  #channel: BroadcastChannel | null = null;
  #lockDepth = 0;
  #pageshowBound = false;

  constructor(channelName = "opensesame-duress-fence") {
    if (globalThis.BroadcastChannel !== undefined) {
      this.#channel = new BroadcastChannel(channelName);
      this.#channel.onmessage = () => {
        // Hint only — never trust peer payload; re-read durable store.
        this.rehydrateFromDurable({ bumpIfChanged: true });
      };
    }
    this.rehydrateFromDurable({ bumpIfChanged: false });
  }

  /**
   * Bind the BFCache guard, on first use rather than at construction.
   *
   * This module exports a singleton, so binding in the constructor made
   * `import`ing anything that reaches the fence add a `pageshow` listener —
   * and an optional capability's module reaches it through Access ›
   * Requests, whose approval flow uses the duress unlock bridge. A module
   * runtime must do nothing at import (ADR 0130), and the per-module purity
   * test caught exactly this listener.
   *
   * Binding later loses nothing: the guard exists to drop a *live* context
   * on a BFCache restore, and until a caller has touched the fence there is
   * no live context to drop. Every entry point that can create one calls
   * this first.
   */
  #bindBfcache(): void {
    if (this.#pageshowBound || globalThis.addEventListener === undefined) {
      return;
    }
    this.#pageshowBound = true;
    globalThis.addEventListener("pageshow", (event: Event) => {
      const persistedFlag =
        "persisted" in event
          ? overlapCast<Event, { persisted: BoundaryValue }>(event).persisted
          : undefined;
      const persisted = isBoolean(persistedFlag) && persistedFlag === true;
      if (!persisted) return;
      // BFCache restore (AT-038): durable fence wins; drop live context handle.
      this.rehydrateFromDurable({ bumpIfChanged: true });
      this.#context = null;
      this.guard.bump();
    });
  }

  readFence(): FenceState {
    this.#bindBfcache();
    return this.#fence;
  }

  currentContext(): AccessContext | null {
    this.#bindBfcache();
    return this.#context;
  }

  setContext(ctx: AccessContext | null): void {
    this.#bindBfcache();
    this.#context = ctx;
  }

  /**
   * Re-read durable fence (lost BroadcastChannel / multi-tab). Never restores
   * AccessContext — opaque handles must be re-issued (AUTH-A).
   */
  rehydrateFromDurable(opts?: { bumpIfChanged?: boolean }): FenceState {
    const durable = readDurableFence();
    if (!durable) return this.#fence;
    const changed =
      durable.incidentEpoch !== this.#fence.incidentEpoch ||
      durable.policyRevision !== this.#fence.policyRevision ||
      durable.keyEpoch !== this.#fence.keyEpoch ||
      durable.retiredDevice !== this.#fence.retiredDevice ||
      durable.activeIncidentIds.join("\0") !==
        this.#fence.activeIncidentIds.join("\0");
    if (changed) {
      this.#fence = durable;
      this.#context = null;
      if (opts?.bumpIfChanged !== false) this.guard.bump();
    }
    return this.#fence;
  }

  /**
   * Lock ordering (AUTH-C): fence lock first. Refuses nested re-entry so IAM
   * assert paths cannot recurse through fence mutation.
   */
  async withFenceLock<T>(run: () => Promise<T> | T): Promise<T> {
    if (this.#lockDepth > 0) {
      throw new Error("fence_lock_reentry: nested IAM/fence lock refused");
    }
    const execute = async (): Promise<T> => {
      this.#lockDepth += 1;
      try {
        return await run();
      } finally {
        this.#lockDepth -= 1;
      }
    };
    const locks = globalThis.navigator?.locks;
    if (locks?.request) {
      return locks.request(FENCE_LOCK_NAME, execute);
    }
    return execute();
  }

  /**
   * Monotonic activation: epochs only increase; denies accumulate; compartments
   * intersect with prior admissions when already restricted (AUTH-E / INV-13).
   */
  activate(next: {
    incidentId: string;
    policyRevision: number;
    keyEpoch: number;
    denyOperations: readonly string[];
    admittedCompartmentRefs: readonly string[];
  }): FenceState {
    this.rehydrateFromDurable({ bumpIfChanged: true });
    this.guard.bump();
    const deny = new Set([
      ...this.#fence.denyOperations,
      ...next.denyOperations,
    ]);
    let admitted = [...next.admittedCompartmentRefs];
    if (this.#fence.activeIncidentIds.length > 0) {
      const prior = new Set(this.#fence.admittedCompartmentRefs);
      admitted = admitted.filter((c) => prior.has(c));
    }
    this.#fence = {
      incidentEpoch: this.#fence.incidentEpoch + 1,
      policyRevision: Math.max(this.#fence.policyRevision, next.policyRevision),
      keyEpoch: Math.max(this.#fence.keyEpoch, next.keyEpoch),
      activeIncidentIds: [...this.#fence.activeIncidentIds, next.incidentId],
      denyOperations: [...deny],
      admittedCompartmentRefs: admitted,
      retiredDevice: this.#fence.retiredDevice,
    };
    persistFence(this.#fence);
    this.#channel?.postMessage({
      type: "fence_changed",
      epoch: this.#fence.incidentEpoch,
    });
    return this.#fence;
  }

  /**
   * Narrow resolution only. Replayed ACK / resolution with stale epoch cannot
   * clear a newer fence (AT-040 / AUTH-E).
   */
  resolve(
    incidentIds: readonly string[],
    authorized: boolean,
    resolutionEpoch?: number,
  ): FenceState {
    this.rehydrateFromDurable({ bumpIfChanged: true });
    if (!authorized) throw new Error("recovery_required");
    if (
      resolutionEpoch !== undefined &&
      this.rejectStaleResolution(resolutionEpoch)
    ) {
      throw new Error("stale_resolution");
    }
    const remaining = this.#fence.activeIncidentIds.filter(
      (id) => !incidentIds.includes(id),
    );
    if (remaining.length === 0) {
      this.#fence = emptyFence();
      this.#context = null;
      this.guard.bump();
      try {
        globalThis.localStorage?.removeItem(FENCE_STORAGE_KEY);
      } catch {
        /* ignore */
      }
    } else {
      // Partial resolve: keep accumulated denies/admissions; only drop IDs.
      this.#fence = {
        ...this.#fence,
        activeIncidentIds: remaining,
        incidentEpoch: this.#fence.incidentEpoch + 1,
      };
      this.guard.bump();
      persistFence(this.#fence);
    }
    this.#channel?.postMessage({ type: "fence_resolved" });
    return this.#fence;
  }

  markRetiredDevice(): void {
    this.#fence = { ...this.#fence, retiredDevice: true };
    persistFence(this.#fence);
    this.guard.bump();
  }

  /** Replayed old resolution with lower epoch must not clear newer fence (AT-040). */
  rejectStaleResolution(resolutionEpoch: number): boolean {
    return resolutionEpoch < this.#fence.incidentEpoch;
  }
}

export const duressSessionFence = new DuressSessionFence();
