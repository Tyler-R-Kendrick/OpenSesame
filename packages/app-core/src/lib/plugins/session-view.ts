/**
 * The view a plugin session draws and the store that holds it: one value,
 * published to whoever listens, and nothing after `close`. Pure; no port.
 */

import {
  type PluginDaemonTarget,
  PluginError,
  type PluginErrorCode,
} from "./client.js";
import type { PluginNotice, PluginState } from "./wire.js";

export type PluginView = Readonly<{
  /** The paired daemon, or null when there is none to ask. */
  daemon: PluginDaemonTarget | null;
  /** Null until the daemon answered, or when it reported no such plugin. */
  state: PluginState | null;
  notices: readonly PluginNotice[];
  /** Whether the daemon has answered for this daemon at least once. */
  read: boolean;
  busy: boolean;
  error: PluginErrorCode | null;
}>;

export const IDLE: PluginView = {
  daemon: null,
  state: null,
  notices: [],
  read: false,
  busy: false,
  error: null,
};

/** How long one call may take before the panel says it went unanswered. */
export const REQUEST_MS = 10_000;

/** The code a refusal carries; anything else is a call that went unanswered. */
export function codeOf<Thrown>(error: Thrown): PluginErrorCode {
  return error instanceof PluginError ? error.code : "unreachable";
}

/** The view and who is told when it changes; nothing after `close`. */
export function viewStore() {
  let view: PluginView = IDLE;
  let closed = false;
  const listeners = new Set<() => void>();
  return {
    view: () => view,
    closed: () => closed,
    publish(next: PluginView): void {
      if (closed) return;
      view = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close(): void {
      closed = true;
      listeners.clear();
      view = IDLE;
    },
  };
}

export type Bounded = <T>(
  work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

/** One call's signal: the session's lifetime, capped at {@link REQUEST_MS}. */
export function boundedBy(lifetime: AbortSignal): Bounded {
  return async (work) => {
    const call = new AbortController();
    const stop = () => call.abort();
    lifetime.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, REQUEST_MS);
    try {
      return await work(call.signal);
    } finally {
      clearTimeout(timer);
      lifetime.removeEventListener("abort", stop);
    }
  };
}

export type ViewStore = ReturnType<typeof viewStore>;

/** Run one of the port's pairing calls, then read whatever it changed. */
export async function runPairing(
  store: ViewStore,
  bounded: Bounded,
  work: ((signal: AbortSignal) => Promise<void>) | undefined,
  ensure: () => void,
): Promise<void> {
  if (store.closed() || store.view().busy || work === undefined) return;
  store.publish({ ...store.view(), busy: true, error: null });
  try {
    await bounded(work);
    store.publish({ ...store.view(), busy: false });
    ensure();
  } catch (error) {
    store.publish({ ...store.view(), busy: false, error: codeOf(error) });
  }
}
