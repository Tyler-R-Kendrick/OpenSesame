/** Linear's provider egress and cleanup exist only while its owning capability is active. */
import { LINEAR_API_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { deviceProviderRevokers } from "@opensesame/app-core/lib/device-connectors.js";
import { linearApiSeams } from "@opensesame/app-core/lib/linear-api.js";
import { applyLinearClientId } from "@opensesame/app-core/lib/linear-connectors.js";
import { revokeLinearConnector } from "@opensesame/app-core/lib/linear-revoke.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";

export function bindLinearRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  applyLinearClientId(ctx.runtimeConfig.linearClientId);
  const lifetime = new AbortController();
  const activeSignal = anySignal([ctx.lease.signal, lifetime.signal]);
  const inactiveFetch = linearApiSeams.fetch;
  linearApiSeams.fetch = (url, init) => {
    const signals = init?.signal ? [activeSignal, init.signal] : [activeSignal];
    const signal = anySignal(signals);
    return runUnlessAborted(signal, () =>
      ctx.egress.fetch(
        url instanceof Request ? url.url : url,
        { ...init, signal },
        { capability: "connectors.external", purpose: LINEAR_API_PURPOSE },
      ),
    );
  };
  deviceProviderRevokers.linear = revokeLinearConnector;
  activation.onDispose(() => {
    lifetime.abort();
    applyLinearClientId(undefined);
    linearApiSeams.fetch = inactiveFetch;
    deviceProviderRevokers.linear = undefined;
  });
}
