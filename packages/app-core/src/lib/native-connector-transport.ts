/** One actual socket and the original capability/network authority that owns it. */
export type NativeProviderSocket = {
  readonly socket: WebSocket;
  assertCurrent: () => void;
};

/** Optional provider runtime supplies lease-fenced egress; imports never enable networking. */
export type NativeProviderTransport = {
  fetch: typeof fetch;
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

export function nativeProviderTransport(): NativeProviderTransport {
  active.assertCurrent();
  return active;
}
