/** One actual socket and the original capability/network authority that owns it. */
export type NativeProviderSocket = {
  readonly socket: WebSocket;
  assertCurrent: () => void;
};

/** Optional provider runtime supplies lease-fenced egress; imports never enable networking. */
export type NativeProviderTransport = {
  fetch: typeof fetch;
  /** Capture one original configured networking authority for a provider session. */
  capture?: () => NativeProviderTransport;
  /** Exact HTTPS origin covered by this captured original native route and egress grant. */
  supportsNativeOrigin?: (origin: string) => boolean;
  /** HTTP-only activations omit this; callers must refuse before sending. */
  openWebSocket?: (
    url: URL,
    protocols: readonly string[],
    signal?: AbortSignal,
  ) => NativeProviderSocket;
  /** The original activation lifetime; captured callers never adopt a later lease. */
  readonly signal?: AbortSignal;
  assertCurrent: () => void;
  /** Credential minting already sent to a provider must settle for durable compensation. */
  settleCredentialMutation?: typeof fetch;
};

function unavailable(): never {
  throw new Error("Enable External connectors to use this provider connection");
}

const INACTIVE: NativeProviderTransport = {
  fetch: async () => unavailable(),
  assertCurrent: unavailable,
};

let active: NativeProviderTransport = INACTIVE;

/** The activation owns this registration; callers capture one lease, never a later activation. */
export function bindNativeProviderTransport(
  transport: NativeProviderTransport,
): () => void {
  active = transport;
  return () => {
    if (active === transport) active = INACTIVE;
  };
}

function captureNativeTransportMethods(original: NativeProviderTransport) {
  return {
    fetch: original.fetch,
    capture: original.capture,
    assertCurrent: original.assertCurrent,
    signal: original.signal,
    openWebSocket: original.openWebSocket,
    supportsNativeOrigin: original.supportsNativeOrigin,
    settleCredentialMutation: original.settleCredentialMutation,
  };
}
function assertNativeTransportMethods(
  original: NativeProviderTransport,
  methods: NativeProviderTransport,
) {
  if (
    original.assertCurrent !== methods.assertCurrent ||
    original.capture !== methods.capture ||
    original.fetch !== methods.fetch ||
    original.signal !== methods.signal ||
    original.openWebSocket !== methods.openWebSocket ||
    original.supportsNativeOrigin !== methods.supportsNativeOrigin ||
    original.settleCredentialMutation !== methods.settleCredentialMutation
  )
    throw new Error("The native provider activation changed during capture.");
}
function guardNativeProviderSnapshot(
  original: NativeProviderTransport,
  authority: () => void,
): NativeProviderTransport {
  const methods = captureNativeTransportMethods(original);
  const assertCurrent = () => {
    authority();
    assertNativeTransportMethods(original, methods);
    methods.assertCurrent.call(original);
    authority();
    assertNativeTransportMethods(original, methods);
  };
  const snapshot: NativeProviderTransport = {
    signal: methods.signal,
    assertCurrent,
    fetch: (input, init) => {
      assertCurrent();
      return methods.fetch.call(original, input, init);
    },
  };
  const settling = methods.settleCredentialMutation;
  if (settling)
    snapshot.settleCredentialMutation = (input, init) => {
      assertCurrent();
      // Submission retains the original promise; withdrawal cannot discard
      // an already-issued credential before its coordinator can journal it.
      return settling.call(original, input, init);
    };
  const supports = methods.supportsNativeOrigin;
  if (supports)
    snapshot.supportsNativeOrigin = (origin) => {
      assertCurrent();
      const supported = supports.call(original, origin);
      assertCurrent();
      return supported;
    };
  const socket = methods.openWebSocket;
  if (socket)
    snapshot.openWebSocket = (url, protocols, signal) => {
      assertCurrent();
      const opened = socket.call(original, url, protocols, signal);
      assertCurrent();
      return opened;
    };
  assertCurrent();
  return Object.freeze(snapshot);
}
/** Retain one activation; route snapshots are acquired only at an operation boundary. */
export function captureNativeProviderAuthority() {
  const original = active;
  const methods = captureNativeTransportMethods(original);
  const assertCurrent = () => {
    if (active !== original)
      throw new Error("The native provider activation changed during capture.");
    assertNativeTransportMethods(original, methods);
    methods.assertCurrent.call(original);
    if (active !== original)
      throw new Error("The native provider activation changed during capture.");
    assertNativeTransportMethods(original, methods);
  };
  assertCurrent();
  return Object.freeze({
    assertCurrent,
    capture: () => {
      assertCurrent();
      const captured = methods.capture?.call(original) ?? original;
      assertCurrent();
      return guardNativeProviderSnapshot(captured, assertCurrent);
    },
  });
}

export function nativeProviderTransport(): NativeProviderTransport {
  const original = active;
  original.assertCurrent();
  const captured = original.capture?.() ?? original;
  original.assertCurrent();
  if (active !== original)
    throw new Error("The native provider activation changed during capture.");
  captured.assertCurrent();
  return captured;
}
