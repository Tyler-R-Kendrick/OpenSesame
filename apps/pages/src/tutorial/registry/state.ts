/**
 * Safe state predicates — the only application state a guide may wait on.
 *
 * Every predicate answers "did the person arrive?", "did the panel open?",
 * "is this available?". None of them answers "what did the person type?".
 * A predicate reads a boolean out of the app; it never reads a field, a vault
 * record, an item name or anything a person authored, which is why the whole
 * registry can be handed to a model as page context.
 */

import type { GuidePredicateId } from "@opensesame/guide-lang";
import type { SupportStateFact } from "@opensesame/support-agent";

export type GuidePredicateDescriptor = {
  readonly id: GuidePredicateId;
  readonly description: string;
  readonly read: () => boolean;
};

const descriptors = new Map<GuidePredicateId, GuidePredicateDescriptor>();
const listeners = new Set<() => void>();

/**
 * Declares a predicate. Called at module scope by the catalog and by screens
 * that own a piece of transient UI state (an open dialog, say).
 */
export function declareGuidePredicate(
  descriptor: GuidePredicateDescriptor,
): void {
  if (descriptors.has(descriptor.id)) {
    throw new Error(`guide_predicate_declared_twice:${descriptor.id}`);
  }
  descriptors.set(descriptor.id, descriptor);
}

export function isKnownGuidePredicate(id: GuidePredicateId): boolean {
  return descriptors.has(id);
}

export function readGuidePredicate(id: GuidePredicateId): boolean {
  const descriptor = descriptors.get(id);
  if (!descriptor) throw new Error(`guide_predicate_unknown:${id}`);
  return descriptor.read();
}

export function guidePredicateIds(): readonly GuidePredicateId[] {
  return [...descriptors.keys()];
}

export function describeGuideState(): readonly SupportStateFact[] {
  return [...descriptors.values()].map((descriptor) => ({
    id: descriptor.id,
    value: descriptor.read(),
  }));
}

/**
 * Screens call this after changing something a predicate reports. Waiting is
 * edge-driven rather than polled, so nothing in the tutorial system scans the
 * DOM or spins a timer looking for state changes.
 */
export function announceGuideStateChange(): void {
  for (const listener of [...listeners]) listener();
}

export function observeGuidePredicate(
  id: GuidePredicateId,
  expected: boolean,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    if (readGuidePredicate(id) === expected) {
      queueMicrotask(resolve);
      return;
    }
    const check = () => {
      if (readGuidePredicate(id) !== expected) return;
      stop();
      resolve();
    };
    const onAbort = () => {
      stop();
      reject(new DOMException("aborted", "AbortError"));
    };
    const stop = () => {
      listeners.delete(check);
      signal.removeEventListener("abort", onAbort);
    };
    listeners.add(check);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Test seam: drops declarations so a suite can rebuild the registry. */
export function resetGuidePredicatesForTest(): void {
  descriptors.clear();
  listeners.clear();
}
