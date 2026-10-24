import { aiCompletionSeams } from "@opensesame/app-core/lib/ai-connections/http.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import {
  AiConnectionError,
  type AiConnectionTransport,
} from "@opensesame/app-core/lib/ai-connections/types.js";
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { notifyModelKeys } from "@opensesame/app-core/lib/model-keys/active.js";
import type { NativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import { initializeVaultCredentialCustody } from "@opensesame/app-core/lib/vault-credential-custody.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";
import { captureBrowserNodeTransport } from "./browser-node-transport.js";

function aiFetch(
  port: NativeProviderTransport,
  signal: AbortSignal,
): AiConnectionTransport["fetch"] {
  return async (input, init) => {
    port.assertCurrent();
    signal.throwIfAborted();
    const requestSignal = init?.signal
      ? anySignal([signal, init.signal])
      : signal;
    return runUnlessAborted(requestSignal, () => {
      if (init?.signal)
        aiCompletionSeams.observe?.({
          phase: "signal",
          httpSignal: init.signal,
          fetchSignal: requestSignal,
        });
      return port.fetch(input, { ...init, signal: requestSignal });
    });
  };
}

/** Each explicit AI workflow captures the original approved direct or configured native route. */
export function bindAiConnectionRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const egress = ctx.egress;
  const fetcher = egress.fetch;
  const decision = egress.decide;
  const lease = ctx.lease;
  const leaseSignal = lease.signal;
  const lifetime = new AbortController();
  const signal = anySignal([leaseSignal, lifetime.signal]);
  const assertCurrent = () => {
    if (
      signal.aborted ||
      activation.disposed() ||
      ctx.egress !== egress ||
      egress.fetch !== fetcher ||
      egress.decide !== decision ||
      ctx.lease !== lease ||
      lease.signal !== leaseSignal
    )
      throw new AiConnectionError(
        "stale",
        "External connectors changed. Reconnect this AI service.",
      );
  };
  const base: NativeProviderTransport = Object.freeze<NativeProviderTransport>({
    assertCurrent,
    signal,
    fetch: (input, init) => {
      assertCurrent();
      if (input instanceof Request)
        throw new AiConnectionError(
          "configuration",
          "Direct AI requests require a string or URL.",
        );
      return fetcher.call(egress, input, init, {
        capability: "connectors.external",
        purpose: NATIVE_PROVIDER_PURPOSE,
      });
    },
  });
  const decide: ApprovedCapabilityContext["egress"]["decide"] = (
    input,
    metadata,
  ) => {
    assertCurrent();
    const result = decision.call(egress, input, metadata);
    assertCurrent();
    return result;
  };
  const carrierContext = { ...ctx, egress: { ...egress, decide } };
  const assertEndpointAllowed = (endpoint: string) => {
    assertCurrent();
    const decision = decide(endpoint, {
      capability: "connectors.external",
      purpose: NATIVE_PROVIDER_PURPOSE,
    });
    if (!decision.ok)
      throw new EgressDenied(
        decision.code,
        "connectors.external",
        decision.destination,
      );
    assertCurrent();
  };
  const release = bindAiConnectionTransport({
    assertCurrent,
    signal,
    assertEndpointAllowed,
    fetch: aiFetch(base, signal),
    capture: () => {
      assertCurrent();
      const captured = captureBrowserNodeTransport(base, carrierContext);
      assertCurrent();
      return {
        signal,
        assertCurrent: () => {
          assertCurrent();
          captured.assertCurrent();
        },
        assertEndpointAllowed: (endpoint) => {
          captured.assertCurrent();
          assertEndpointAllowed(endpoint);
          captured.assertCurrent();
        },
        fetch: aiFetch(captured, signal),
      };
    },
  });
  void initializeVaultCredentialCustody()
    .then(() => {
      if (!signal.aborted && !activation.disposed()) notifyModelKeys();
    })
    .catch(() => undefined);
  activation.onDispose(() => {
    lifetime.abort();
    release();
  });
}
