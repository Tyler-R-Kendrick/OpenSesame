/**
 * React hooks over the capability composition: the store's snapshot, the
 * advisory OpenFeature read and the offline worker's status. Each is a
 * `useSyncExternalStore` over a subscribe/read pair the core exports
 * (ADR 0133 §1).
 *
 * `useComposition` and `useCompositionContributions` read through the
 * composition seam (`lib/configuration/capabilities-ports.ts`), so a suite
 * that replaces the seam with its double drives these hooks too.
 */

import {
  capabilityEnabled,
  subscribeCapabilityFlags,
} from "@opensesame/app-core/lib/capabilities/openfeature-consumer.js";
import type { ContributionEntry } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import {
  type WorkerStatus,
  subscribeWorkerStatus,
  workerStatus,
} from "@opensesame/app-core/lib/capabilities/worker-controller.js";
import {
  compositionStore,
  contributionSource,
} from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import type {
  CapabilityId,
  CapabilityState,
  ContributionKind,
} from "@opensesame/capability-composition";
import { useMemo, useSyncExternalStore } from "react";

export function useComposition(): CompositionSnapshot {
  return useSyncExternalStore(
    compositionStore.subscribe,
    compositionStore.getSnapshot,
    compositionStore.getSnapshot,
  );
}

export function useCapability(id: CapabilityId): CapabilityState | null {
  const snapshot = useComposition();
  return snapshot.plan?.capabilities[id] ?? null;
}

/** The seam's contributions of `kind`, re-read when its source moves. */
export function useCompositionContributions<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  const version = useSyncExternalStore(
    contributionSource.subscribe,
    () => contributionSource.version(kind),
    () => contributionSource.version(kind),
  );
  // `version` is the cache key: the source answers anew only when it moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the read's cache key
  return useMemo(() => contributionSource.read(kind), [kind, version]);
}

/** React binding of `capabilityEnabled`; re-renders on provider events. */
export function useCapabilityFlag(id: CapabilityId): boolean {
  return useSyncExternalStore(
    subscribeCapabilityFlags,
    () => capabilityEnabled(id),
    () => false,
  );
}

export function useWorkerStatus(): WorkerStatus {
  return useSyncExternalStore(
    subscribeWorkerStatus,
    workerStatus,
    workerStatus,
  );
}
