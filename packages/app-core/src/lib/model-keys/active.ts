/**
 * The broker of the running page (ADR 0192).
 *
 * One capability activation binds one broker and releases it when it ends, the
 * same shape as `bindHostedModelAuthority`: a caller that was handed a broker
 * earlier cannot keep using it after the activation that owned it is gone,
 * because the page asks here each time and gets `null` once it is released.
 * Keys live in that broker's memory only, so a lock, a reload or a disabled
 * capability ends every one of them.
 */
import type { ModelKeyBroker } from "./broker.js";

let active: ModelKeyBroker | null = null;
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/**
 * Bind `broker` as the page's. A broker it replaces is reset on the spot: its
 * keys were issued under an activation that is over, and whoever still holds
 * it must not keep keys a lock should have ended. Returns the release, which
 * resets its own broker even when it has been replaced since, and leaves the
 * page's current one alone.
 */
export function bindModelKeyBroker(broker: ModelKeyBroker): () => void {
  if (active !== null && active !== broker) active.reset();
  active = broker;
  notify();
  return () => {
    broker.reset();
    if (active !== broker) return;
    active = null;
    notify();
  };
}

export function activeModelKeyBroker(): ModelKeyBroker | null {
  return active;
}

/** Tell watchers the set of keys, or what one may still do, changed. */
export function notifyModelKeys(): void {
  notify();
}

export function subscribeModelKeys(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A number that changes whenever a key does: the snapshot a store hook compares. */
export function modelKeysVersion(): number {
  return version;
}
