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
  /** A worker already controlled this page when the controller started. */
  bootControlled: boolean;
  /** The release the page's shell belongs to: its first controller's answer. */
  bootReleaseId: string | null;
  /** A hello is out and unanswered; another is not sent on top of it. */
  helloPending: boolean;
  /**
   * The controller changed and the new one has been asked which release it
   * is; the answer decides whether this page reloads. Cancels its own timeout.
   */
  takeover: { cancel: () => void } | null;
  /** Set by the controller: re-read which variant holds the scope. */
  afterTakeover: (() => void) | null;
  /** The page has already been told to reload for a new release. */
  reloadStarted: boolean;
  reconciling: Promise<void>;
  /** The highest `?r=` this page has asked a script for. */
  asked: number;
  /** Times the controller came back to a replacement it had given up on. */
  recoveries: number;
  /** Cancels the pending look-again timer, if one is set. */
  recheckCancel: (() => void) | null;
};

const INITIAL_STATUS: WorkerStatus = {
  supported: true,
  variant: null,
  requiredVariant: null,
  pendingVariant: null,
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
    bootControlled: false,
    bootReleaseId: null,
    helloPending: false,
    takeover: null,
    afterTakeover: null,
    reloadStarted: false,
    reconciling: Promise.resolve(),
    asked: 0,
    recoveries: 0,
    recheckCancel: null,
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
  state.recheckCancel?.();
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
