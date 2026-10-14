import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { bindTailscaleTransport } from "@opensesame/app-core/lib/tailscale/transport.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";

/** Tailscale requests use captured PWA egress without a bridge or companion. */
export function bindTailscaleRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const lifetime = new AbortController();
  const signal = anySignal([ctx.lease.signal, lifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || activation.disposed())
      throw new Error(
        "External connectors changed. Reopen Tailscale settings.",
      );
  };
  const release = bindTailscaleTransport({
    assertCurrent,
    fetch: async (input, init) => {
      assertCurrent();
      const requestSignal = init?.signal
        ? anySignal([signal, init.signal])
        : signal;
      const result = await runUnlessAborted(requestSignal, () =>
        ctx.egress.fetch(
          input,
          { ...init, signal: requestSignal },
          {
            capability: "connectors.external",
            purpose: NATIVE_PROVIDER_PURPOSE,
          },
        ),
      );
      assertCurrent();
      return result;
    },
  });
  activation.onDispose(() => {
    lifetime.abort();
    release();
  });
}
