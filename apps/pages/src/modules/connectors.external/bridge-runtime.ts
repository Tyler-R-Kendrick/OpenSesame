/**
 * The connector bridge, bound for the life of the connections activation (ADR
 * 0199). The channel is this window talking to itself: the extension's relay,
 * if one is registered for this origin, hears a message the page posts and
 * posts the answer back. Nothing is asked of an extension until this runs, and
 * a person who has none installed sees nothing happen: no answer is "absent".
 */
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { createBridgeClient } from "@opensesame/app-core/lib/connector-bridge-client.js";
import type { BridgeChannel } from "@opensesame/app-core/lib/connector-bridge-client.js";
import {
  bindNativeBridge,
  bridgeCarries,
  bridgedFetch,
  refreshNativeBridge,
} from "@opensesame/app-core/lib/native-bridge.js";
import type { Activation } from "../activation.js";
import { runUnlessAborted } from "../signals.js";

function safeUrl(value: string | URL): URL | null {
  try {
    return value instanceof URL ? value : new URL(value);
  } catch {
    return null;
  }
}

/**
 * A provider whose servers refuse web pages is called through the connector
 * bridge, at a host a person allowed in it, after the same egress decision a
 * direct request gets (ADR 0199). `null` when the bridge does not carry this
 * request: the caller then sends it as it always did.
 */
export function carriedByBridge(
  ctx: ApprovedCapabilityContext,
  request: { url: string | URL; init: RequestInit },
  signal: AbortSignal,
): Promise<Response> | null {
  const destination = safeUrl(request.url);
  if (!destination || !bridgeCarries(destination)) return null;
  const decision = ctx.egress.decide(request.url, {
    capability: "connectors.external",
    purpose: NATIVE_PROVIDER_PURPOSE,
  });
  if (!decision.ok)
    throw new EgressDenied(
      decision.code,
      "connectors.external",
      decision.destination,
    );
  return runUnlessAborted(signal, () =>
    bridgedFetch(request.url, { ...request.init, signal }),
  );
}

/** A message the page posted to itself, or one the relay posted back: from this window and this origin only. */
export function windowChannel(target: Window = window): BridgeChannel {
  return {
    post: (message) => target.postMessage(message, target.location.origin),
    listen(handler) {
      const hear = (event: MessageEvent) => {
        if (event.source !== target || event.origin !== target.location.origin)
          return;
        handler(event.data);
      };
      target.addEventListener("message", hear);
      return () => target.removeEventListener("message", hear);
    },
  };
}

export function bindBridgeRuntime(
  activation: Activation,
  target: Window | undefined = globalThis.window,
): void {
  // A worker or a test with no window has no extension to ask.
  if (!target) return;
  const client = createBridgeClient(windowChannel(target));
  const release = bindNativeBridge(client);
  // A person may install the bridge, switch it on or allow a host while this
  // page is open; asking again when they come back is how the page finds out.
  const again = () => {
    if (!activation.disposed()) void refreshNativeBridge();
  };
  target.addEventListener("focus", again);
  target.document.addEventListener("visibilitychange", again);
  activation.onDispose(() => {
    target.removeEventListener("focus", again);
    target.document.removeEventListener("visibilitychange", again);
    release();
    // Requests already sent are still read when they land; nothing new starts.
    client.drain();
  });
  void refreshNativeBridge();
}
