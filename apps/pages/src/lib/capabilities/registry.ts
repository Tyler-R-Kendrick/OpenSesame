/**
 * Contribution registry (ownership.md §4.2): what approved modules add to
 * the shell — sections, routes, settings categories, commands, tools.
 *
 * Every registration is fenced by generation. Reads answer only entries
 * registered under the store's *current* generation, so a bump makes every
 * older contribution vanish before its module has been disposed; and a
 * registrar refuses a lease that is stale, unbound, or bound to a capability
 * the current plan does not approve. Entries are sorted by `order`, then by
 * their id, so two builds with the same plan draw the same shell.
 */

import type {
  ActivationLease,
  CapabilityId,
  ContributionKind,
  RegistrationHandle,
} from "@opensesame/capability-composition";
import { leaseIsCurrent } from "./lease.js";
import {
  CapabilityDenied,
  type ContributionEntry,
} from "./runtime-contract.js";
import { compositionStore } from "./store.js";

type Registration = Readonly<{
  token: number;
  kind: ContributionKind;
  capability: CapabilityId;
  generation: number;
  entry: unknown;
}>;

const registrations = new Map<number, Registration>();
const leaseCapability = new WeakMap<ActivationLease, CapabilityId>();
const listeners = new Set<() => void>();
const cache = new Map<
  ContributionKind,
  { version: number; entries: readonly unknown[] }
>();
let version = 0;
let nextToken = 1;
const EMPTY: readonly unknown[] = Object.freeze([]);

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

// A generation bump changes what `contributions()` answers even when no
// registration moved, so readers follow the store as well as the registry.
compositionStore.subscribe(notify);

/** Loader-only: name the capability a (child) lease acts for. */
export function bindLeaseToCapability(
  lease: ActivationLease,
  capability: CapabilityId,
): void {
  leaseCapability.set(lease, capability);
}

/** The capability a lease was bound to, if any. */
export function leaseCapabilityOf(lease: ActivationLease): CapabilityId | null {
  return leaseCapability.get(lease) ?? null;
}

function entryKey(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) return "";
  const record = entry as Record<string, unknown>;
  for (const field of ["id", "path", "key", "name", "kind"]) {
    const value = record[field];
    if (typeof value === "string") return value;
  }
  return "";
}

function entryOrder(entry: unknown): number {
  if (typeof entry !== "object" || entry === null) return 0;
  const order = (entry as Record<string, unknown>).order;
  return typeof order === "number" && Number.isFinite(order) ? order : 0;
}

function compareEntries(a: unknown, b: unknown): number {
  const byOrder = entryOrder(a) - entryOrder(b);
  if (byOrder !== 0) return byOrder;
  const ka = entryKey(a);
  const kb = entryKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

export function registerContribution<K extends ContributionKind>(
  kind: K,
  entry: ContributionEntry<K>,
  lease: ActivationLease,
): RegistrationHandle {
  const snapshot = compositionStore.getSnapshot();
  if (!leaseIsCurrent(lease, snapshot.generation)) {
    throw new CapabilityDenied("STALE_LEASE", kind);
  }
  const capability = leaseCapability.get(lease);
  if (!capability) throw new CapabilityDenied("LEASE_UNBOUND", kind);
  if (!snapshot.plan?.approvedCapabilities.includes(capability)) {
    throw new CapabilityDenied("NOT_APPROVED", capability);
  }
  const token = nextToken++;
  registrations.set(token, {
    token,
    kind,
    capability,
    generation: lease.generation,
    entry,
  });
  notify();
  const revoke = () => {
    if (registrations.delete(token)) notify();
  };
  lease.signal.addEventListener("abort", revoke, { once: true });
  return { kind, capability, generation: lease.generation, revoke };
}

/** Drop every registration made under `generation` (or older). Idempotent. */
export function revokeGeneration(generation: number): void {
  let changed = false;
  for (const [token, registration] of registrations) {
    if (registration.generation <= generation) {
      registrations.delete(token);
      changed = true;
    }
  }
  if (changed) notify();
}

/** Current-generation entries of one kind, sorted; referentially stable per version. */
export function contributions<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  const cached = cache.get(kind);
  if (cached && cached.version === version) {
    return cached.entries as readonly ContributionEntry<K>[];
  }
  const current = compositionStore.getSnapshot().generation;
  const entries = [...registrations.values()]
    .filter((r) => r.kind === kind && r.generation === current)
    .map((r) => r.entry)
    .sort(compareEntries);
  const stable = entries.length === 0 ? EMPTY : Object.freeze(entries);
  cache.set(kind, { version, entries: stable });
  return stable as readonly ContributionEntry<K>[];
}

export function subscribeRegistry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test-only: forget every registration. */
export function resetRegistryForTest(): void {
  registrations.clear();
  cache.clear();
  notify();
}
