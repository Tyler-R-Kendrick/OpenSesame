/** One original receiver and owner for an issuer operation, captured before any await. */
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { NativeApiError } from "./native-api-http.js";
import {
  type NativeProviderTransport,
  captureNativeProviderAuthority,
} from "./native-connector-transport.js";
import type { NativeKeyFlows } from "./native-key-driver.js";

function capture(original: NativeProviderTransport): NativeProviderTransport {
  const fetch = original.fetch;
  const assertCurrent = original.assertCurrent;
  const signal = original.signal;
  const supportsNativeOrigin = original.supportsNativeOrigin;
  const captureRoute = original.capture;
  let retired = false;
  const unchanged = () => {
    if (
      retired ||
      original.fetch !== fetch ||
      original.assertCurrent !== assertCurrent ||
      original.signal !== signal ||
      original.supportsNativeOrigin !== supportsNativeOrigin ||
      original.capture !== captureRoute ||
      signal?.aborted
    ) {
      retired = true;
      throw new NativeApiError("deployment");
    }
  };
  const check = () => {
    unchanged();
    try {
      assertCurrent.call(original);
      unchanged();
    } catch (error) {
      retired = true;
      throw error;
    }
    unchanged();
  };
  const transport: NativeProviderTransport = {
    assertCurrent: check,
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      check();
      const response = await fetch.call(original, input, init);
      try {
        check();
        return response;
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }
    },
  };
  if (supportsNativeOrigin)
    transport.supportsNativeOrigin = (origin) => {
      check();
      const supported = supportsNativeOrigin.call(original, origin);
      check();
      return supported;
    };
  check();
  return signal ? { ...transport, signal } : transport;
}

function draft(input: NativeApiConfigureInput): NativeApiConfigureInput {
  return {
    ...input,
    parameters: { ...input.parameters },
    credentials: { ...input.credentials },
    targetIds: { ...input.targetIds },
    requestedScopes: Object.fromEntries(
      Object.entries(input.requestedScopes ?? {}).map(([key, values]) => [
        key,
        [...values],
      ]),
    ),
  };
}

/** The shared saved-key loader awaits before calling a provider: snapshot at its front door. */
export function googleWalletTransportFlows(
  flows: NativeKeyFlows,
): NativeKeyFlows {
  return {
    ...flows,
    configure: async (
      input,
      transport = captureNativeProviderAuthority().capture(),
    ) => flows.configure(draft(input), capture(transport)),
    verify: async (
      id,
      transport = captureNativeProviderAuthority().capture(),
    ) => flows.verify(id, capture(transport)),
    invoke: (
      id,
      operation,
      input = {},
      transport = captureNativeProviderAuthority().capture(),
    ) => flows.invoke(id, operation, { ...input }, capture(transport)),
  };
}
