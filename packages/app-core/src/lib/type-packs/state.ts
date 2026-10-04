/**
 * What the item-type packs are doing right now (ADR 0164).
 *
 * A pack is one built-in item type that is not in the entry bundle. Switching
 * it on is a short journey the screen has to be able to show, so the journey
 * is state, not a spinner a component owns:
 *
 *   off → queued → downloading → installing → on
 *                       ↘ failed ↙ (a switch press retries)
 *
 * The snapshot is immutable and replaced on every change, so
 * `useSyncExternalStore` re-renders only when something moved. Nothing here
 * does work: `installer.ts` moves packs through it, `watch.ts` reports which
 * types the open vault already holds items of.
 */

import { isPackLoaded, packEntries } from "@opensesame/vault-item-types";

export type PackPhase =
  | "off"
  | "queued"
  | "downloading"
  | "installing"
  | "on"
  | "failed";

export type PackStatus = Readonly<{
  phase: PackPhase;
  /** In words, when `phase` is `failed`. */
  reason?: string;
}>;

export type PackSnapshot = Readonly<{
  /** Only packs that have moved; read through `statusOf`. */
  status: Readonly<Record<string, PackStatus>>;
  /** Items of each type the open vault holds. A type with items stays on. */
  counts: ReadonlyMap<string, number>;
  /** Packs queued, downloading or installing. */
  pending: number;
  /** Packs that finished in the current run of work, for "3 of 18". */
  settled: number;
  revision: number;
}>;

const OFF: PackStatus = { phase: "off" };
const ON: PackStatus = { phase: "on" };

let snapshot: PackSnapshot = {
  status: {},
  counts: new Map(),
  pending: 0,
  settled: 0,
  revision: 0,
};
const listeners = new Set<() => void>();

export function getPackSnapshot(): PackSnapshot {
  return snapshot;
}

export function subscribePackState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The status of one pack: what it has done, else whether it is loaded. */
export function statusOf(
  id: string,
  from: PackSnapshot = snapshot,
): PackStatus {
  return from.status[id] ?? (isPackLoaded(id) ? ON : OFF);
}

/**
 * Whether a pack has been switched on in this document, by a person or because
 * the open vault holds items of it. Stricter than `statusOf`, which also calls
 * a pack on when something else loaded it: this is the creation surface's
 * question, and only an explicit state answers it.
 */
export function isPackOn(id: string, from: PackSnapshot = snapshot): boolean {
  return from.status[id]?.phase === "on";
}

export function isBusy(phase: PackPhase): boolean {
  return (
    phase === "queued" || phase === "downloading" || phase === "installing"
  );
}

function pendingIn(status: Readonly<Record<string, PackStatus>>): number {
  let count = 0;
  for (const entry of packEntries()) {
    if (isBusy((status[entry.id] ?? OFF).phase)) count += 1;
  }
  return count;
}

function commit(next: Omit<PackSnapshot, "revision" | "pending">): void {
  snapshot = {
    ...next,
    pending: pendingIn(next.status),
    revision: snapshot.revision + 1,
  };
  for (const listener of [...listeners]) listener();
}

export function setStatus(id: string, status: PackStatus): void {
  const before = snapshot.status[id];
  if (before?.phase === status.phase && before.reason === status.reason) return;
  const settled =
    status.phase === "on" || status.phase === "failed"
      ? snapshot.settled + 1
      : snapshot.settled;
  commit({
    ...snapshot,
    status: { ...snapshot.status, [id]: status },
    settled,
  });
}

/** A run of work is over: the next one counts from zero. */
export function resetSettled(): void {
  if (snapshot.settled === 0) return;
  commit({ ...snapshot, settled: 0 });
}

export function setCounts(counts: ReadonlyMap<string, number>): void {
  const same =
    counts.size === snapshot.counts.size &&
    [...counts].every(([id, n]) => snapshot.counts.get(id) === n);
  if (same) return;
  commit({ ...snapshot, counts });
}

/** Test seam: forget everything, as a fresh document would. */
export function resetPackStateForTests(): void {
  snapshot = {
    status: {},
    counts: new Map(),
    pending: 0,
    settled: 0,
    revision: 0,
  };
  for (const listener of [...listeners]) listener();
}
