/**
 * The broker of the running page (ADR 0188).
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

/** Bind `broker` as the page's. Returns the release; a stale release is a no-op. */
export function bindModelKeyBroker(broker: ModelKeyBroker): () => void {
  active = broker;
  notify();
  return () => {
    if (active !== broker) return;
    broker.reset();
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
