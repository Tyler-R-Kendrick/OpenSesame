/**
 * React hooks over the contribution registry and its shell face
 * (`lib/capabilities/registry.ts`, `lib/contributions.ts`). The logic stays
 * in the core; this file only subscribes to it (ADR 0133 §1).
 */

import {
  contributions,
  subscribeRegistry,
} from "@opensesame/app-core/lib/capabilities/registry.js";
import type {
  ContributionEntry,
  ItemKindContribution,
} from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import {
  contributionsSnapshot,
  injectedContributionsVersion,
  subscribeInjected,
} from "@opensesame/app-core/lib/contributions.js";
import {
  type ItemKindRow,
  itemKindsFrom,
} from "@opensesame/app-core/lib/item-kinds.js";
import type { ContributionKind } from "@opensesame/capability-composition";
import { useMemo, useSyncExternalStore } from "react";

/** The registry's entries of `kind` alone, re-read on every registration. */
export function useRegistryContributions<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  return useSyncExternalStore(
    subscribeRegistry,
    () => contributions(kind),
    () => contributions(kind),
  );
}

/** Generation-fenced hook over the same set the sync accessor returns. */
export function useContributions<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  const fromRegistry = useRegistryContributions(kind);
  const version = useSyncExternalStore(
    subscribeInjected,
    injectedContributionsVersion,
    injectedContributionsVersion,
  );
  // The snapshot is keyed by exactly these two; the deps say when it moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fromRegistry/version are the snapshot's cache keys
  return useMemo(
    () => contributionsSnapshot(kind),
    [kind, fromRegistry, version],
  );
}

/** Core kinds plus the approved `item-kind` contributions, sorted. */
export function useItemKinds(): readonly ItemKindRow[] {
  const entries: readonly ItemKindContribution[] =
    useContributions("item-kind");
  return useMemo(() => itemKindsFrom(entries), [entries]);
}
