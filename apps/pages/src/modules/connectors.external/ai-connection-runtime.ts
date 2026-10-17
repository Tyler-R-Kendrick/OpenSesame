import { aiCompletionSeams } from "@opensesame/app-core/lib/ai-connections/http.js";
import { bindAiConnectionTransport } from "@opensesame/app-core/lib/ai-connections/transport.js";
import { AiConnectionError } from "@opensesame/app-core/lib/ai-connections/types.js";
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { notifyModelKeys } from "@opensesame/app-core/lib/model-keys/active.js";
import { initializeVaultCredentialCustody } from "@opensesame/app-core/lib/vault-credential-custody.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";

/** Custom model endpoints use approved direct egress, including every stream read's owner signal. */
export function bindAiConnectionRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const lifetime = new AbortController();
  const signal = anySignal([ctx.lease.signal, lifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || activation.disposed())
      throw new AiConnectionError(
        "stale",
        "External connectors changed. Reconnect this AI service.",
      );
  };
  const release = bindAiConnectionTransport({
    assertCurrent,
    signal,
    assertEndpointAllowed(endpoint) {
      assertCurrent();
      const decision = ctx.egress.decide(endpoint, {
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
    },
    fetch: async (input, init) => {
      assertCurrent();
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
        return ctx.egress.fetch(
          input,
          { ...init, signal: requestSignal },
          {
            capability: "connectors.external",
            purpose: NATIVE_PROVIDER_PURPOSE,
          },
        );
      });
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
