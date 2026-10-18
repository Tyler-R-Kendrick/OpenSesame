import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import type { NativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import {
  type TailscaleBrowserNode,
  type TailscaleNativeHTTPPort,
  tailscaleBrowserNode,
} from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import { savedBrowserNodeConfiguration } from "@opensesame/app-core/lib/tailscale/browser-node-store.js";
import { anySignal } from "../signals.js";

/** Captured independently of the provider attempt; original node lifetime still owns the port. */
function captureNativePort(
  node: TailscaleBrowserNode | null,
): TailscaleNativeHTTPPort | null {
  try {
    return node?.captureNativeHTTP?.(new AbortController().signal) ?? null;
  } catch {
    return null;
  }
}
/** Capture before authentication; existing provider sessions never adopt a later node. */
export function captureBrowserNodeTransport(
  base: NativeProviderTransport,
  ctx: ApprovedCapabilityContext,
): NativeProviderTransport {
  const configuration = savedBrowserNodeConfiguration();
  if (!configuration?.nativeHTTP) return base;
  const receipt = JSON.stringify(configuration);
  const origins = new Set(
    configuration.nativeHTTP.targets.map((target) => target.origin),
  );
  const node = tailscaleBrowserNode();
  const captured = captureNativePort(node);
  let used = false;
  const nodeCurrent = () => {
    if (
      !captured ||
      tailscaleBrowserNode() !== node ||
      JSON.stringify(savedBrowserNodeConfiguration()) !== receipt
    )
      throw new Error(
        "Reconnect this provider after connecting the configured browser node.",
      );
    captured.assertCurrent();
  };
  const route = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    settling: boolean,
  ): Promise<Response> | null => {
    const destination = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    if (!origins.has(destination.origin)) return null;
    base.assertCurrent();
    nodeCurrent();
    const decision = ctx.egress.decide(destination, {
      capability: "connectors.external",
      purpose: NATIVE_PROVIDER_PURPOSE,
    });
    if (!decision.ok)
      throw new EgressDenied(
        decision.code,
        "connectors.external",
        decision.destination,
      );
    nodeCurrent();
    if (!captured)
      throw new Error("The configured browser node is unavailable.");
    const request = new Request(input, init);
    const signals = [request.signal];
    if (settling) signals.push(AbortSignal.timeout(15_000));
    else if (base.signal) signals.push(base.signal);
    used = true;
    return captured.fetch(request, { signal: anySignal(signals) });
  };
  const mutation = base.settleCredentialMutation;
  return Object.freeze({
    ...base,
    capture: undefined,
    supportsNativeOrigin: (origin: string) => {
      try {
        base.assertCurrent();
        const destination = new URL(origin);
        if (destination.origin !== origin || !origins.has(origin)) return false;
        nodeCurrent();
        const decision = ctx.egress.decide(destination, {
          capability: "connectors.external",
          purpose: NATIVE_PROVIDER_PURPOSE,
        });
        nodeCurrent();
        base.assertCurrent();
        if (decision.ok) used = true;
        return decision.ok;
      } catch {
        return false;
      }
    },
    assertCurrent: () => {
      base.assertCurrent();
      if (used) nodeCurrent();
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      base.assertCurrent();
      const carried = route(input, init, false);
      return carried ?? base.fetch(input, init);
    },
    ...(mutation
      ? {
          settleCredentialMutation: async (
            input: RequestInfo | URL,
            init?: RequestInit,
          ) => {
            base.assertCurrent();
            const carried = route(input, init, true);
            return carried ?? mutation(input, init);
          },
        }
      : {}),
  });
}
