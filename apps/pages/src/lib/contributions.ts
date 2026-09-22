/**
 * The shell's view of what optional capabilities contribute.
 *
 * Navigation, search, commands, shortcuts, settings categories, tutorials
 * and item creation all derive from the effective plan's contributions
 * (ownership.md §4.2). This module is the one seam they read through: a
 * generation-fenced, revocable set per `ContributionKind`, sorted by `order`
 * then id, exposed as a React hook and as a synchronous snapshot for the
 * places that cannot call a hook (the keymap handler, the crumb builders,
 * the WebMCP tool table).
 *
 * The registrar contract is S06's (`lib/capabilities/registry.ts`):
 * `registerContribution(kind, entry, lease)` and `useContributions(kind)`.
 * Until that file lands, the store here is the implementation; once it does,
 * `registerContribution`/`useContributions`/`contributionsSnapshot` become
 * re-exports of it and nothing that imports this module changes. Only one
 * registry may exist — this is not a second one, it is the consumer face.
 */

import type { ContributionKind } from "@opensesame/capability-composition";
import { useSyncExternalStore } from "react";
import type { ContributionEntry } from "./capabilities/runtime-contract.js";

type Registered<K extends ContributionKind> = Readonly<{
  kind: K;
  entry: ContributionEntry<K>;
  /** Registration order, the tie-breaker after `order` and id. */
  seq: number;
}>;

const registered = new Map<ContributionKind, Registered<ContributionKind>[]>();
const snapshots = new Map<ContributionKind, readonly unknown[]>();
const listeners = new Set<() => void>();
let seq = 0;

const EMPTY: readonly never[] = Object.freeze([]);

function orderOf(entry: unknown): number {
  if (entry !== null && typeof entry === "object" && "order" in entry) {
    const value = (entry as { order?: unknown }).order;
    return typeof value === "number" ? value : 0;
  }
  return 0;
}

function idOf(entry: unknown): string {
  if (entry === null || typeof entry !== "object") return "";
  const record = entry as Record<string, unknown>;
  for (const field of ["id", "path", "key", "kind", "name"]) {
    const value = record[field];
    if (typeof value === "string") return value;
  }
  return "";
}

function compare(
  left: Registered<ContributionKind>,
  right: Registered<ContributionKind>,
): number {
  const byOrder = orderOf(left.entry) - orderOf(right.entry);
  if (byOrder !== 0) return byOrder;
  const byId = idOf(left.entry).localeCompare(idOf(right.entry));
  if (byId !== 0) return byId;
  return left.seq - right.seq;
}

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Adds one contribution. Returns its revoke, idempotent. Module runtimes call
 * this through `ApprovedCapabilityContext.register`; tests call it directly.
 */
export function registerContribution<K extends ContributionKind>(
  kind: K,
  entry: ContributionEntry<K>,
): () => void {
  const record: Registered<K> = { kind, entry, seq: seq++ };
  const list = registered.get(kind) ?? [];
  registered.set(kind, [...list, record]);
  snapshots.delete(kind);
  announce();
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    const live = registered.get(kind);
    if (!live) return;
    const remaining = live.filter((candidate) => candidate !== record);
    if (remaining.length === 0) registered.delete(kind);
    else registered.set(kind, remaining);
    snapshots.delete(kind);
    announce();
  };
}

/** Every live contribution of `kind`, sorted; a stable array between changes. */
export function contributionsSnapshot<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  const cached = snapshots.get(kind);
  if (cached) return cached as readonly ContributionEntry<K>[];
  const live = registered.get(kind);
  if (!live || live.length === 0) return EMPTY;
  const sorted = Object.freeze(
    [...live].sort(compare).map((record) => record.entry),
  ) as readonly ContributionEntry<K>[];
  snapshots.set(kind, sorted);
  return sorted;
}

export function subscribeContributions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Generation-fenced hook over the same snapshot the sync accessor returns. */
export function useContributions<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  return useSyncExternalStore(
    subscribeContributions,
    () => contributionsSnapshot(kind),
    () => contributionsSnapshot(kind),
  );
}

/** Drops every contribution. Tests only. */
export function resetContributionsForTest(): void {
  registered.clear();
  snapshots.clear();
  announce();
}
