/**
 * The shell's view of what optional capabilities contribute.
 *
 * Navigation, search, commands, shortcuts, settings categories, tutorials
 * and item creation all derive from the effective plan's contributions
 * (ownership.md §4.2). This module is the one seam they read through, and it
 * is a *face* on S06's registry (`lib/capabilities/registry.ts`), not a
 * second registry: every production entry arrives through
 * `registerContribution(kind, entry, lease)` there, generation-fenced and
 * sorted by `order` then id.
 *
 * What this adds is a synchronous snapshot for the places that cannot call a
 * hook (the hook itself is `bindings/contributions.ts`) (the keymap handler, the crumb builders, the WebMCP tool table, the
 * tutorial registries), and a test-only side channel that lets a jsdom test
 * inject a contribution without booting a store, resolving a plan and
 * minting a lease. Nothing in production code calls the test channel.
 */

import type { ContributionKind } from "@opensesame/capability-composition";
import { contributions, subscribeRegistry } from "./capabilities/registry.js";
import type { ContributionEntry } from "./capabilities/runtime-contract.js";

type Injected<K extends ContributionKind> = Readonly<{
  kind: K;
  entry: ContributionEntry<K>;
  seq: number;
}>;

const injected = new Map<ContributionKind, Injected<ContributionKind>[]>();
const injectedListeners = new Set<() => void>();
let injectedVersion = 0;
let seq = 0;

const EMPTY: readonly never[] = Object.freeze([]);

type Merged = {
  registry: readonly unknown[];
  version: number;
  out: readonly unknown[];
};
const merged = new Map<ContributionKind, Merged>();

function orderOf(entry: unknown): number {
  if (entry === null || typeof entry !== "object") return 0;
  const value = (entry as { order?: unknown }).order;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function idOf(entry: unknown): string {
  if (entry === null || typeof entry !== "object") return "";
  const record = entry as Record<string, unknown>;
  for (const field of ["id", "path", "key", "name", "kind"]) {
    const value = record[field];
    if (typeof value === "string") return value;
  }
  return "";
}

function compare(left: unknown, right: unknown): number {
  const byOrder = orderOf(left) - orderOf(right);
  if (byOrder !== 0) return byOrder;
  return idOf(left).localeCompare(idOf(right));
}

function injectedOf<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  const list = injected.get(kind);
  if (!list || list.length === 0) return EMPTY;
  return list.map((record) => record.entry) as ContributionEntry<K>[];
}

/**
 * Every live contribution of `kind`, sorted; a stable array while neither
 * the registry's generation-fenced set nor the injected set has changed.
 */
export function contributionsSnapshot<K extends ContributionKind>(
  kind: K,
): readonly ContributionEntry<K>[] {
  const fromRegistry = contributions(kind);
  const cached = merged.get(kind);
  if (
    cached &&
    cached.registry === fromRegistry &&
    cached.version === injectedVersion
  ) {
    return cached.out as readonly ContributionEntry<K>[];
  }
  const extra = injectedOf(kind);
  const out =
    extra.length === 0
      ? fromRegistry
      : Object.freeze([...fromRegistry, ...extra].sort(compare));
  merged.set(kind, { registry: fromRegistry, version: injectedVersion, out });
  return out as readonly ContributionEntry<K>[];
}

export function subscribeInjected(listener: () => void): () => void {
  injectedListeners.add(listener);
  return () => {
    injectedListeners.delete(listener);
  };
}

/**
 * Notified when the test channel changes. The registry announces its own
 * changes through `useContributions`; a synchronous reader that needs to
 * know about those compares snapshot references instead (they are stable
 * per registry version), which is what the tutorial registries do.
 */
/**
 * Notify on every change to the set `contributionsSnapshot` returns — the
 * registry's own registrations *and* the test channel's.
 *
 * This used to subscribe to the test channel alone, so in production it
 * never fired: a module registering a `webmcp-tool` announced nothing, and
 * the one caller that re-reads on change — the WebMCP surface, whose doc
 * says "both re-register when that set changes, so approving or disabling
 * another capability mid-session is reflected without a reload" — held
 * whatever snapshot happened to exist when it mounted. With three
 * capabilities approved that was the whole set; with six the wallet's eight
 * session tools registered after the surface mounted and never reached the
 * browser at all.
 */
export function subscribeContributions(listener: () => void): () => void {
  const stopRegistry = subscribeRegistry(listener);
  const stopInjected = subscribeInjected(listener);
  return () => {
    stopRegistry();
    stopInjected();
  };
}

/** Moves whenever the test channel changes; a hook's cache key. */
export function injectedContributionsVersion(): number {
  return injectedVersion;
}

function announceInjected(): void {
  injectedVersion += 1;
  for (const listener of [...injectedListeners]) listener();
}

/**
 * Test-only: add a contribution beside the registry's. Returns its revoke,
 * idempotent. A jsdom test uses this where a module's `activate` would have
 * registered under a lease; production code never calls it.
 */
export function registerContributionForTest<K extends ContributionKind>(
  kind: K,
  entry: ContributionEntry<K>,
): () => void {
  const record: Injected<K> = { kind, entry, seq: seq++ };
  injected.set(kind, [...(injected.get(kind) ?? []), record]);
  announceInjected();
  let revoked = false;
  return () => {
    if (revoked) return;
    revoked = true;
    const live = injected.get(kind);
    if (!live) return;
    const remaining = live.filter((candidate) => candidate !== record);
    if (remaining.length === 0) injected.delete(kind);
    else injected.set(kind, remaining);
    announceInjected();
  };
}

/** Test-only: drop every injected contribution. */
export function resetContributionsForTest(): void {
  injected.clear();
  announceInjected();
}
