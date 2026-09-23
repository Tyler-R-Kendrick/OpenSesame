/**
 * What the worker controller publishes and what it is handed
 * (ownership.md §4.7; PWA-02, PWA-03, PWA-06).
 *
 * Types only — no state, no effects — so the state module, the plan-sync
 * module and the controller itself can all speak the same vocabulary without
 * importing one another.
 */

import type {
  ConsentReceipt,
  DistributionContract,
  EffectivePlan,
  InstallationCapabilitySelection,
} from "@opensesame/capability-composition";

export type OfflineStatus =
  | "online-only"
  | "saving"
  | "saved"
  | "partial"
  | "storage-unavailable";

export type WorkerTransition = Readonly<{
  from: string | null;
  to: string;
  status: "transition-required" | "transitioning";
}>;

export type WorkerStatus = Readonly<{
  /** False when the page has no usable `navigator.serviceWorker`. */
  supported: boolean;
  /** Variant of the script registered for this scope, when known. */
  variant: string | null;
  /** Variant the current plan requires (`core-only` when the plan says null). */
  requiredVariant: string | null;
  /** The controlling worker's release id, from `WORKER_INFO`. */
  releaseId: string | null;
  offlineStatus: OfflineStatus;
  transition: WorkerTransition | null;
  /** Human-readable, never secrets. */
  diagnostics: readonly string[];
}>;

/** The slice of §4.1's snapshot this controller reads. */
export type CompositionSnapshotForWorker = Readonly<{
  plan: EffectivePlan | null;
  selection: InstallationCapabilitySelection | null;
  receipt: ConsentReceipt | null;
}>;

export type CompositionStoreForWorker = Readonly<{
  getSnapshot(): CompositionSnapshotForWorker;
  subscribe(listener: () => void): () => void;
}>;

export type RegisterWorkerOptions = Readonly<{
  /** `virtual:opensesame-distribution`'s `DISTRIBUTION` (S07). */
  distribution: DistributionContract;
}>;

/** What the page may say to its worker (`src/sw/messages.ts` is the other side). */
export type PageToWorkerMessage =
  | Readonly<{ type: "WORKER_HELLO" }>
  | Readonly<{
      type: "PLAN_ASSETS";
      releaseId: string;
      planDigest: string;
      moduleIds: readonly string[];
    }>;

/** A registration this page holds that must be retired before the next one. */
export type PendingTransition = Readonly<{
  registration: ServiceWorkerRegistration;
  scriptUrl: string;
  to: string;
}>;

export const CORE_ONLY_VARIANT = "core-only";
export const WORKER_GRAPH_UNAVAILABLE = "WORKER_GRAPH_UNAVAILABLE";

/** The capability a non-core variant exists for; registration waits on it. */
export const VARIANT_CAPABILITY: ReadonlyMap<string, string> = new Map([
  ["push", "notifications.web-push"],
]);
