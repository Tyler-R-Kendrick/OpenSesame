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
  /** Variant of the script that is active for this scope, when known. */
  variant: string | null;
  /** Variant the current plan requires (`core-only` when the plan says null). */
  requiredVariant: string | null;
  /** Variant of a worker this page asked for that has not taken the scope yet. */
  pendingVariant: string | null;
  /** The controlling worker's release id, from `WORKER_INFO`. */
  releaseId: string | null;
  offlineStatus: OfflineStatus;
  /**
   * Page module ids the controlling release has saved for offline use, sorted:
   * the modules of every plan it answered `OFFLINE_READY` for. Empty unless
   * delivery is `selected-only`; cleared when another release takes over.
   */
  savedModuleIds: readonly string[];
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
  /** Told what the worker saved, so each capability can say it is cached. */
  setOfflineSaved?(moduleIds: readonly string[]): void;
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

/** How long a replacement worker may take to activate before it is given up on. */
export const ACTIVATION_WAIT_MS = 60_000;
/**
 * How long an installed replacement may sit waiting before it is asked for
 * again. Activation normally follows install within a second or two; a worker
 * still waiting after this is wedged (see `worker/activation.ts`).
 */
export const WAITING_NUDGE_MS = 5_000;
/** How long a page waits for the worker that took it to say which release it is. */
export const TAKEOVER_WAIT_MS = 2_000;

export const CORE_ONLY_VARIANT = "core-only";
export const WORKER_GRAPH_UNAVAILABLE = "WORKER_GRAPH_UNAVAILABLE";

/** The capability a non-core variant exists for; registration waits on it. */
export const VARIANT_CAPABILITY: ReadonlyMap<string, string> = new Map([
  ["push", "notifications.web-push"],
]);
