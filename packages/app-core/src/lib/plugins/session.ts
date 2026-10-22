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
  type ViewStore,
  boundedBy,
  codeOf,
  pairingActions,
  pairingCalls,
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

async function loadPluginView(
  store: ViewStore,
  plugin: PluginEntry,
  daemon: PluginDaemon,
  bounded: Bounded,
  target: PluginDaemonTarget,
  keep: boolean,
  fresh: () => boolean,
): Promise<void> {
  store.publish({
    ...(keep ? store.view() : IDLE),
    daemon: target,
    busy: true,
  });
  try {
    const read = await readPlugin(plugin, pinnedTo(daemon, target), bounded);
    if (!fresh()) return;
    store.publish({
      ...(keep ? store.view() : IDLE),
      daemon: target,
      ...read,
      read: true,
      busy: false,
      error: null,
    });
  } catch (error) {
    if (!fresh()) return;
    store.publish({
      ...(keep ? store.view() : IDLE),
      daemon: target,
      busy: false,
      error: codeOf(error),
    });
  }
}

export function createPluginSession(plugin: PluginEntry, daemon: PluginDaemon) {
  const store = viewStore();
  const lifetime = new AbortController();
  const bounded = boundedBy(lifetime.signal);
  const calls = pairingCalls(lifetime.signal);
  /**
   * The pairing the view was read from (daemon host and pairing revision);
   * any other one reads again. Undefined until the first ask.
   */
  let readFrom: PluginDaemonTarget | null | undefined;
  /** Bumped each time `readFrom` moves; an answer for an older one is stale. */
  let epoch = 0;
  let unwatch: (() => void) | null = null;

  async function load(
    target: PluginDaemonTarget,
    keep: boolean,
  ): Promise<void> {
    const mine = epoch;
    await loadPluginView(
      store,
      plugin,
      daemon,
      calls.bounded(),
      target,
      keep,
      () => epoch === mine,
    );
  }

  /** Read (again) when the paired daemon changed; forget when there is none. */
  function ensure(force = false, keep = false): void {
    if (store.closed()) return;
    // Asked once, then told: a pairing that loads after unlock, or one
    // forgotten, reads again without the panel having to ask.
    if (unwatch === null && daemon.subscribe)
      unwatch = daemon.subscribe(ensure);
    const target = daemon.target();
    if (!force && readFrom !== undefined && sameTarget(target, readFrom))
      return;
    readFrom = target;
    epoch += 1;
    calls.supersede();
    if (target === null) store.publish(IDLE);
    else void load(target, keep);
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
    const inEpoch = calls.bounded();
    store.publish({ ...store.view(), busy: true, error: null });
    try {
      const next = await inEpoch((signal) =>
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

  /** Read the daemon again without blanking the panel while it answers. */
  function refresh(): void {
    if (!store.closed() && !store.view().busy) ensure(true, true);
  }

  return {
    plugin,
    view: store.view,
    subscribe: store.subscribe,
    ensure,
    refresh,
    toggle,
    ...pairingActions(daemon, store, bounded, ensure),
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
