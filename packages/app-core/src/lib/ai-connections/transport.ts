import { AiConnectionError, type AiConnectionTransport } from "./types.js";

let active: AiConnectionTransport | null = null;

export function bindAiConnectionTransport(
  transport: AiConnectionTransport,
): () => void {
  active = transport;
  return () => {
    if (active === transport) active = null;
  };
}

function stale(): never {
  throw new AiConnectionError(
    "stale",
    "External connectors changed. Reconnect this AI service.",
  );
}

/** Readiness projections keep the exact registered identity and never acquire routes. */
export function aiConnectionTransport(): AiConnectionTransport {
  const original = active;
  if (!original)
    throw new AiConnectionError(
      "stale",
      "Enable External connectors before connecting an AI service.",
    );
  original.assertCurrent();
  original.signal.throwIfAborted();
  if (active !== original) return stale();
  return original;
}

function methods(port: AiConnectionTransport) {
  return {
    fetch: port.fetch,
    signal: port.signal,
    assertCurrent: port.assertCurrent,
    capture: port.capture,
    assertEndpointAllowed: port.assertEndpointAllowed,
  };
}
function unchanged(
  port: AiConnectionTransport,
  held: ReturnType<typeof methods>,
) {
  if (
    port.fetch !== held.fetch ||
    port.signal !== held.signal ||
    port.assertCurrent !== held.assertCurrent ||
    port.capture !== held.capture ||
    port.assertEndpointAllowed !== held.assertEndpointAllowed
  )
    stale();
}
function guarded(
  port: AiConnectionTransport,
  authority: () => void,
): AiConnectionTransport {
  const held = methods(port);
  const assertCurrent = () => {
    authority();
    unchanged(port, held);
    held.assertCurrent.call(port);
    held.signal.throwIfAborted();
    authority();
    unchanged(port, held);
  };
  const captured: AiConnectionTransport = {
    signal: held.signal,
    assertCurrent,
    fetch: (input, init) => {
      assertCurrent();
      return held.fetch.call(port, input, init);
    },
  };
  const admit = held.assertEndpointAllowed;
  if (admit)
    captured.assertEndpointAllowed = (endpoint) => {
      assertCurrent();
      admit.call(port, endpoint);
      assertCurrent();
    };
  assertCurrent();
  return Object.freeze(captured);
}

/** An explicit workflow retains one original registration and route across every await. */
export function captureAiConnectionTransport(): AiConnectionTransport {
  const original = aiConnectionTransport();
  const held = methods(original);
  const authority = () => {
    if (active !== original) stale();
    unchanged(original, held);
    held.assertCurrent.call(original);
    held.signal.throwIfAborted();
    if (active !== original) stale();
    unchanged(original, held);
  };
  authority();
  const snapshot = held.capture?.call(original) ?? original;
  authority();
  return guarded(snapshot, authority);
}
