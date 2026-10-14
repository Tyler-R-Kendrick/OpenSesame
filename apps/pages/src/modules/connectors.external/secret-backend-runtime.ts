import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { bindSecretBackendTransport } from "@opensesame/app-core/lib/secret-backends/transport.js";
import { SecretBackendError } from "@opensesame/app-core/lib/secret-backends/types.js";
import type { Activation } from "../activation.js";
import { anySignal, runUnlessAborted } from "../signals.js";

/** Preserve Request bodies and headers when adapting fetch to the destination-aware port. */
async function requestArguments(input: Request, overrides?: RequestInit) {
  const request = new Request(input, overrides);
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    signal: request.signal,
  };
  if (request.body !== null) init.body = await request.arrayBuffer();
  return { url: request.url, init };
}

/** Direct PWA egress only. No native-provider bridge or global fetch is installed. */
export function bindSecretBackendRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const lifetime = new AbortController();
  const signal = anySignal([ctx.lease.signal, lifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || activation.disposed())
      throw new SecretBackendError(
        "stale",
        "External connectors were disabled. Reconnect this secret backend.",
      );
  };
  const release = bindSecretBackendTransport({
    signal,
    assertCurrent,
    fetch: async (input, init) => {
      assertCurrent();
      const request =
        input instanceof Request
          ? await runUnlessAborted(signal, () => requestArguments(input, init))
          : { url: input, init: init ?? {} };
      assertCurrent();
      const requestSignal = request.init.signal
        ? anySignal([signal, request.init.signal])
        : signal;
      try {
        return await runUnlessAborted(requestSignal, () =>
          ctx.egress.fetch(
            request.url,
            { ...request.init, signal: requestSignal },
            {
              capability: "connectors.external",
              purpose: NATIVE_PROVIDER_PURPOSE,
            },
          ),
        );
      } catch (error) {
        assertCurrent();
        if (error instanceof EgressDenied)
          throw new SecretBackendError(
            "unsupported",
            "The current network or deployment policy does not allow this secret backend.",
          );
        throw error;
      }
    },
  });
  activation.onDispose(() => {
    lifetime.abort();
    release();
  });
}
