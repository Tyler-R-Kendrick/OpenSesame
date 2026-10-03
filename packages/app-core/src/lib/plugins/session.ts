/**
 * One plugin, as one capability's activation sees it: the view its Settings
 * panel and its file are both drawn from (ADR 0134), so neither keeps a copy.
 *
 * Created in `activate`, never at import. It reads nothing until something
 * asks (`ensure`): the panel on mount, the file viewer when it lists. With no
 * daemon paired it sends nothing at all. `dispose` aborts whatever is in
 * flight and forgets the view; it never sends anything.
 */

import type { PluginEntry } from "./catalog.js";
import {
  type PluginDaemon,
  type PluginDaemonTarget,
  PluginError,
  type PluginErrorCode,
  readPluginNotices,
  readPluginStates,
  setPluginEnabled,
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

const IDLE: PluginView = {
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
function codeOf<Thrown>(error: Thrown): PluginErrorCode {
  return error instanceof PluginError ? error.code : "unreachable";
}

/** The view and who is told when it changes; nothing after `close`. */
function viewStore() {
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

type Bounded = <T>(work: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** One call's signal: the session's lifetime, capped at {@link REQUEST_MS}. */
function boundedBy(lifetime: AbortSignal): Bounded {
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

/** The plugin's state, and its tripwires once it is installed. */
async function readPlugin(
  plugin: PluginEntry,
  daemon: PluginDaemon,
  bounded: Bounded,
) {
  const states = await bounded((signal) => readPluginStates(daemon, signal));
  const state = states.find((entry) => entry.id === plugin.id) ?? null;
  const notices =
    state?.installed === true
      ? await bounded((signal) => readPluginNotices(daemon, plugin.id, signal))
      : [];
  return { state, notices };
}

export function createPluginSession(plugin: PluginEntry, daemon: PluginDaemon) {
  const store = viewStore();
  const lifetime = new AbortController();
  const bounded = boundedBy(lifetime.signal);
  /** The daemon host the view was read from; another one reads again. */
  let readFrom: string | null | undefined;
  let unwatch: (() => void) | null = null;

  async function load(target: PluginDaemonTarget): Promise<void> {
    store.publish({ ...IDLE, daemon: target, busy: true });
    try {
      const read = await readPlugin(plugin, daemon, bounded);
      if (readFrom !== target.host) return;
      store.publish({ ...IDLE, daemon: target, ...read, read: true });
    } catch (error) {
      if (readFrom !== target.host) return;
      store.publish({ ...IDLE, daemon: target, error: codeOf(error) });
    }
  }

  /** Read (again) when the paired daemon changed; forget when there is none. */
  function ensure(): void {
    if (store.closed()) return;
    // Asked once, then told: a pairing that loads after unlock, or one
    // forgotten, reads again without the panel having to ask.
    if (unwatch === null && daemon.subscribe)
      unwatch = daemon.subscribe(ensure);
    const target = daemon.target();
    const host = target?.host ?? null;
    if (host === readFrom) return;
    readFrom = host;
    if (target === null) store.publish(IDLE);
    else void load(target);
  }

  /** Switch the plugin; refused before sending when the last read forbids it. */
  async function toggle(): Promise<void> {
    const { state, busy } = store.view();
    if (store.closed() || busy || state === null) return;
    store.publish({ ...store.view(), busy: true, error: null });
    try {
      const next = await bounded((signal) =>
        setPluginEnabled(daemon, state, !state.enabled, signal),
      );
      store.publish({ ...store.view(), state: next, busy: false });
    } catch (error) {
      store.publish({ ...store.view(), busy: false, error: codeOf(error) });
    }
  }

  return {
    plugin,
    view: store.view,
    subscribe: store.subscribe,
    ensure,
    toggle,
    /** Abort what is in flight and forget the view; nothing is sent. */
    dispose(): void {
      store.close();
      unwatch?.();
      unwatch = null;
      lifetime.abort();
    },
  };
}

export type PluginSession = ReturnType<typeof createPluginSession>;
