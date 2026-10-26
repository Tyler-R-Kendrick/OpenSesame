/** A dedicated memory-only node belongs to one approved identity workflow, never persisted node keys. */
import type {
  TailscaleNativeHTTPPort,
  TailscaleNodeConfiguration,
  TailscaleNodeSnapshot,
} from "./browser-node-port.js";
export type IdentityBrowserNodeConfiguration = Pick<
  TailscaleNodeConfiguration,
  "controlURL" | "nativeHTTP"
>;
export type IdentityBrowserNodeOwner = Readonly<{
  signal: AbortSignal;
  assertCurrent: () => void;
}>;
export type IdentityHTTPPort = Readonly<
  TailscaleNativeHTTPPort & {
    supportsNativeOrigin: (origin: string) => boolean;
  }
>;
export type IdentityBrowserNode = Readonly<{
  snapshot: () => TailscaleNodeSnapshot;
  subscribe: (listener: () => void) => () => void;
  start: (configuration: IdentityBrowserNodeConfiguration) => void;
  login: () => void;
  captureNativeHTTP: (owner: AbortSignal) => IdentityHTTPPort;
  stop: () => Promise<boolean>;
}>;
export type IdentityBrowserNodeFactory = (
  owner: IdentityBrowserNodeOwner,
) => IdentityBrowserNode;
type Registration = Readonly<{
  create: IdentityBrowserNodeFactory;
  lifetime: AbortController;
}>;
let registration: Registration | null = null;
export function bindIdentityBrowserNodeFactory(
  create: IdentityBrowserNodeFactory,
): () => void {
  const previous = registration;
  const owned = Object.freeze({ create, lifetime: new AbortController() });
  registration = owned;
  previous?.lifetime.abort();
  if (registration !== owned) {
    owned.lifetime.abort();
    throw new Error("Identity peering activation changed during installation.");
  }
  return () => {
    if (registration === owned) registration = null;
    owned.lifetime.abort();
  };
}
function guardedHTTP(
  port: IdentityHTTPPort,
  check: () => void,
): IdentityHTTPPort {
  const { fetch, assertCurrent, signal, supportsNativeOrigin } = port;
  const unchanged = () => {
    check();
    if (
      port.fetch !== fetch ||
      port.assertCurrent !== assertCurrent ||
      port.signal !== signal ||
      port.supportsNativeOrigin !== supportsNativeOrigin
    )
      throw new Error("Original identity HTTP carrier changed.");
  };
  const current = () => {
    unchanged();
    signal.throwIfAborted();
    assertCurrent.call(port);
    unchanged();
  };
  current();
  return Object.freeze({
    signal,
    assertCurrent: current,
    fetch: async (input, init) => {
      current();
      const response = await fetch.call(port, input, init);
      try {
        current();
      } catch (error) {
        await response.body?.cancel();
        throw error;
      }
      return response;
    },
    supportsNativeOrigin(origin) {
      current();
      const allowed = supportsNativeOrigin.call(port, origin);
      current();
      return allowed;
    },
  });
}
/** Capture synchronously before hydration; the returned facade cannot select another activation. */
export function captureIdentityBrowserNode(
  owner: IdentityBrowserNodeOwner,
): IdentityBrowserNode | null {
  const originalSignal = owner.signal;
  const assertOwner = owner.assertCurrent;
  const captured = registration;
  const signal = captured
    ? AbortSignal.any([originalSignal, captured.lifetime.signal])
    : originalSignal;
  const check = () => {
    signal.throwIfAborted();
    if (
      owner.signal !== originalSignal ||
      owner.assertCurrent !== assertOwner ||
      registration !== captured
    )
      throw new Error("Original identity peering owner changed.");
    assertOwner.call(owner);
    signal.throwIfAborted();
    if (
      owner.signal !== originalSignal ||
      owner.assertCurrent !== assertOwner ||
      registration !== captured
    )
      throw new Error("Original identity peering owner changed.");
  };
  check();
  if (!captured) return null;
  const node = captured.create(Object.freeze({ signal, assertCurrent: check }));
  const methods = {
    snapshot: node.snapshot,
    subscribe: node.subscribe,
    start: node.start,
    login: node.login,
    capture: node.captureNativeHTTP,
    stop: node.stop,
  };
  const current = () => {
    check();
    if (
      node.snapshot !== methods.snapshot ||
      node.subscribe !== methods.subscribe ||
      node.start !== methods.start ||
      node.login !== methods.login ||
      node.captureNativeHTTP !== methods.capture ||
      node.stop !== methods.stop
    )
      throw new Error("Original identity peering node changed.");
  };
  current();
  return Object.freeze({
    snapshot() {
      current();
      const value = methods.snapshot.call(node);
      current();
      return value;
    },
    subscribe(listener) {
      current();
      const stop = methods.subscribe.call(node, listener);
      current();
      return stop;
    },
    start(configuration) {
      current();
      methods.start.call(node, configuration);
      current();
    },
    login() {
      current();
      methods.login.call(node);
      current();
    },
    captureNativeHTTP(caller) {
      current();
      const port = methods.capture.call(node, caller);
      current();
      return guardedHTTP(port, current);
    },
    // Cleanup retains the original receiver even after intentional authority withdrawal.
    stop: () => methods.stop.call(node),
  });
}

/** Reserve the initiating activation without constructing a node for a public HTTP flow. */
export function reserveIdentityBrowserNode(owner: IdentityBrowserNodeOwner) {
  const original = registration;
  const signal = owner.signal;
  const assert = owner.assertCurrent;
  let opened = false;
  const check = () => {
    signal.throwIfAborted();
    if (
      registration !== original ||
      owner.signal !== signal ||
      owner.assertCurrent !== assert
    )
      throw new Error("Original identity peering activation changed.");
    assert.call(owner);
    signal.throwIfAborted();
    if (registration !== original)
      throw new Error("Original identity peering activation changed.");
  };
  return () => {
    if (opened)
      throw new Error("Original identity peering was already opened.");
    opened = true;
    check();
    const node = captureIdentityBrowserNode(
      Object.freeze({ signal, assertCurrent: check }),
    );
    check();
    return node;
  };
}
