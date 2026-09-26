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
  withTypeDirectories,
} from "@opensesame/app-core/lib/item-kinds.js";
import type { ContributionKind } from "@opensesame/capability-composition";
import { type VaultItem, itemTypeId } from "@opensesame/vault-core";
import { useMemo, useRef, useSyncExternalStore } from "react";

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
  const snapshot = useMemo(
    () => contributionsSnapshot(kind),
    [kind, fromRegistry, version],
  );
  return useSameEntries(snapshot);
}

/**
 * The array this hook returned last while its entries are the same ones.
 * The registry re-reads every kind on any registration, and an effect keyed
 * on these entries — the unlock effects, which poll and purge — must not run
 * again because some other kind moved.
 */
function useSameEntries<T>(entries: readonly T[]): readonly T[] {
  const held = useRef(entries);
  const previous = held.current;
  if (
    previous.length === entries.length &&
    previous.every((entry, index) => entry === entries[index])
  ) {
    return previous;
  }
  held.current = entries;
  return entries;
}

/** Core kinds plus the approved `item-kind` contributions, sorted. */
export function useItemKinds(): readonly ItemKindRow[] {
  const entries: readonly ItemKindContribution[] =
    useContributions("item-kind");
  return useMemo(() => itemKindsFrom(entries), [entries]);
}

/**
 * The vault's directories: one per item type — the kinds above, every
 * installed type, and every type the vault holds. Not memoised on purpose:
 * installing a type changes the registry, which is module state no
 * contribution or item reference moves with.
 */
export function useVaultDirectories(
  items: readonly VaultItem[],
): readonly ItemKindRow[] {
  const kinds = useItemKinds();
  return withTypeDirectories(kinds, items.map(itemTypeId));
}
