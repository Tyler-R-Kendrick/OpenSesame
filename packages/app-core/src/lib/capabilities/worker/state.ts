/**
 * The one page-level record of what this document decided about its worker,
 * and the external store a settings surface subscribes to.
 *
 * The record is a single object whose identity never changes — `reset` writes
 * fresh fields into it rather than replacing it — so every module that holds
 * it sees the same thing after a reset.
 */

import type { DistributionContract } from "@opensesame/capability-composition";
import type {
  CompositionSnapshotForWorker,
  PendingTransition,
  WorkerStatus,
} from "./types.js";

export type ControllerState = {
  status: WorkerStatus;
  container: ServiceWorkerContainer | null;
  distribution: DistributionContract | null;
  latest: CompositionSnapshotForWorker | null;
  registeredThisPage: boolean;
  listenersAttached: boolean;
  workerReleaseId: string | null;
  lastPlanKey: string | null;
  /** The plan posted to the worker saving it: its release, digest and modules. */
  postedPlan: Readonly<{
    releaseId: string;
    planDigest: string;
    moduleIds: readonly string[];
  }> | null;
  pendingTransition: PendingTransition | null;
  /**
   * This page itself replaced the registered script and the next
   * `controllerchange` is that replacement taking the page, not a new release:
   * the shell the page runs is the one the new script serves, so the page
   * keeps running and only re-introduces itself to the worker.
   */
  variantSwitch: boolean;
  /** The page has already been told to reload for a new release. */
  reloadStarted: boolean;
  reconciling: Promise<void>;
};

const INITIAL_STATUS: WorkerStatus = {
  supported: true,
  variant: null,
  requiredVariant: null,
  releaseId: null,
  offlineStatus: "online-only",
  savedModuleIds: [],
  transition: null,
  diagnostics: [],
};

function initialFields(): ControllerState {
  return {
    status: INITIAL_STATUS,
    container: null,
    distribution: null,
    latest: null,
    registeredThisPage: false,
    listenersAttached: false,
    workerReleaseId: null,
    lastPlanKey: null,
    postedPlan: null,
    pendingTransition: null,
    variantSwitch: false,
    reloadStarted: false,
    reconciling: Promise.resolve(),
  };
}

export const state: ControllerState = initialFields();

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function publish(patch: Partial<WorkerStatus>): void {
  state.status = { ...state.status, ...patch };
  notify();
}

/** Record a one-word reason, once. Never a URL, a digest or a secret. */
export function diagnose(code: string): void {
  if (state.status.diagnostics.includes(code)) return;
  publish({ diagnostics: [...state.status.diagnostics, code] });
}

/** Test seam: forget every page-level decision. */
export function resetWorkerController(): void {
  Object.assign(state, initialFields());
  notify();
}

export function subscribeWorkerStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function workerStatus(): WorkerStatus {
  return state.status;
}
