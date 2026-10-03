/**
 * One plugin, as one capability's activation sees it: the view its Settings
 * panel and its file are both drawn from (ADR 0134), so neither keeps a copy.
 *
 * Created in `activate`, never at import. It reads nothing until something
 * asks (`ensure`): the panel on mount, the file viewer when it lists. With no
 * daemon paired it sends nothing at all until a person pastes a pairing code
 * (`pair`). `dispose` aborts whatever is in flight and forgets the view; it
 * never sends anything.
 */

import type { PluginEntry } from "./catalog.js";
import {
  type PluginDaemon,
  type PluginDaemonTarget,
  readPluginNotices,
  readPluginStates,
  setPluginEnabled,
} from "./client.js";
import { pinnedTo, sameTarget } from "./pinned.js";
import {
  type Bounded,
  IDLE,
  boundedBy,
  codeOf,
  runPairing,
  viewStore,
} from "./session-view.js";

export { REQUEST_MS, type PluginView } from "./session-view.js";

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
  /**
   * The pairing the view was read from (daemon host and pairing revision);
   * any other one reads again. Undefined until the first ask.
   */
  let readFrom: PluginDaemonTarget | null | undefined;
  /** Bumped each time `readFrom` moves; an answer for an older one is stale. */
  let epoch = 0;
  let unwatch: (() => void) | null = null;

  async function load(target: PluginDaemonTarget): Promise<void> {
    const mine = epoch;
    store.publish({ ...IDLE, daemon: target, busy: true });
    try {
      const read = await readPlugin(plugin, pinnedTo(daemon, target), bounded);
      if (epoch !== mine) return;
      store.publish({ ...IDLE, daemon: target, ...read, read: true });
    } catch (error) {
      if (epoch !== mine) return;
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
    if (readFrom !== undefined && sameTarget(target, readFrom)) return;
    readFrom = target;
    epoch += 1;
    if (target === null) store.publish(IDLE);
    else void load(target);
  }

  /**
   * Switch the plugin; refused before sending when the last read forbids it.
   * The call is bound to the pairing that read came from: if the pairing has
   * moved, nothing is sent, and neither is an answer drawn that was for the
   * old one. The new pairing is read instead.
   */
  async function toggle(): Promise<void> {
    const { state, busy, daemon: target } = store.view();
    if (store.closed() || busy || state === null || target === null) return;
    const mine = epoch;
    store.publish({ ...store.view(), busy: true, error: null });
    try {
      const next = await bounded((signal) =>
        setPluginEnabled(
          pinnedTo(daemon, target),
          state,
          !state.enabled,
          signal,
        ),
      );
      if (epoch !== mine) return;
      store.publish({ ...store.view(), state: next, busy: false });
    } catch (error) {
      if (epoch === mine && codeOf(error) === "target-changed") ensure();
      if (epoch !== mine) return;
      store.publish({ ...store.view(), busy: false, error: codeOf(error) });
    }
  }

  return {
    plugin,
    view: store.view,
    subscribe: store.subscribe,
    ensure,
    toggle,
    /** Whether this port can pair at all, and whether it could right now. */
    pairable: daemon.pair !== undefined,
    canPair: (): boolean => daemon.canPair?.() ?? false,
    /** Trade a pasted pairing code for this page's own key. */
    pair: (code: string) => {
      const pair = daemon.pair;
      return runPairing(
        store,
        bounded,
        pair && ((signal) => pair(code, signal)),
        ensure,
      );
    },
    /** Forget this page's key, revoking it at the daemon when it answers. */
    forget: () => runPairing(store, bounded, daemon.forget, ensure),
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
