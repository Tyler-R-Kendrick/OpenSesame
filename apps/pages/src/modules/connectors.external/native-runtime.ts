/** Native browser providers share the owning capability's lease and declared egress purpose. */
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import { bindNativeProviderTransport } from "@opensesame/app-core/lib/native-connector-transport.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import type { Activation } from "../activation.js";
import { LeaseAbortedError, anySignal, runUnlessAborted } from "../signals.js";
import { bindLinearRuntime } from "./linear-runtime.js";
import { bindNativeApiRuntime } from "./native-api-runtime.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";
import { bindNativeOAuthRuntime } from "./native-oauth-runtime.js";

type ProviderRequest = { url: string | URL; init: RequestInit };
type AuthorizationView = NonNullable<
  ReturnType<typeof nativeDeviceViewSeams.authorization>
>;
/** Egress takes a URL plus init; normalize a Request without discarding its payload. */
async function requestArguments(
  input: Request,
  overrides?: RequestInit,
): Promise<ProviderRequest> {
  const request = new Request(input, overrides);
  const init: RequestInit = {
    ...overrides,
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

const STATUS_DETAILS = {
  configuration:
    "Configured on this device; provider authorization or verification required",
  authorizing: "Provider authorization is in progress",
  connected: null,
  reauthorize: "Provider authorization expired or changed; authorize again",
  cleanup: "Provider cleanup required before this connection can be used",
} satisfies Record<NativeConnectorView["status"], string | null>;
function grantExpiry(view: NativeConnectorView): string | null {
  const expiries = view.grants.flatMap((grant) =>
    grant.expiresAt === null ? [] : [grant.expiresAt],
  );
  return expiries.length ? new Date(Math.min(...expiries)).toISOString() : null;
}

export function bindNativeRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  const lifetime = new AbortController();
  const signal = anySignal([ctx.lease.signal, lifetime.signal]);
  const assertCurrent = () => {
    if (signal.aborted || activation.disposed()) throw new LeaseAbortedError();
  };
  const release = bindNativeProviderTransport({
    assertCurrent,
    settleCredentialMutation: async (url, init) => {
      assertCurrent();
      // The coordinator journals its exchange intent before this call. Once
      // submitted, a complete late token response must be sealed and cleaned
      // up, rather than discarded and left live at the provider. Captured
      // ports still reject every new request after this lease ends.
      const request =
        url instanceof Request
          ? await runUnlessAborted(signal, () => requestArguments(url, init))
          : { url, init: init ?? {} };
      assertCurrent();
      const deadline = AbortSignal.timeout(15_000);
      const requestSignal = request.init.signal
        ? anySignal([request.init.signal, deadline])
        : deadline;
      requestSignal.throwIfAborted();
      return ctx.egress.fetch(
        request.url,
        { ...request.init, signal: requestSignal },
        { capability: "connectors.external", purpose: NATIVE_PROVIDER_PURPOSE },
      );
    },
    fetch: async (url, init) => {
      assertCurrent();
      const request =
        url instanceof Request
          ? await runUnlessAborted(signal, () => requestArguments(url, init))
          : { url, init: init ?? {} };
      assertCurrent();
      const requestSignal = request.init.signal
        ? anySignal([signal, request.init.signal])
        : signal;
      return runUnlessAborted(requestSignal, () =>
        ctx.egress.fetch(
          request.url,
          { ...request.init, signal: requestSignal },
          {
            capability: "connectors.external",
            purpose: NATIVE_PROVIDER_PURPOSE,
          },
        ),
      );
    },
  });
  const previous = nativeDeviceViewSeams.authorization;
  const projector: typeof nativeDeviceViewSeams.authorization = (id) => {
    if (signal.aborted || activation.disposed()) return null;
    const view = readNativeConnector(id);
    if (!view) return null;
    const policy = nativeBrowserMethodPolicy(
      view.providerId,
      view.configuration.method,
      view.configuration.parameters,
    );
    const connected = view.status === "connected" && policy.available;
    const authorization: AuthorizationView = {
      status: connected ? "active" : "pending",
      statusDetail:
        view.status !== "cleanup" && !policy.available
          ? policy.reason
          : STATUS_DETAILS[view.status],
      grantedScopes: connected
        ? view.grants.flatMap((grant) => grant.grantedScopes)
        : [],
      accountLabel:
        view.identity?.assurance === "account-verified"
          ? view.identity.label
          : null,
      expiresAt: grantExpiry(view),
      refreshable:
        policy.available &&
        view.status !== "cleanup" &&
        Object.values(
          loadNativeConnectorRecord(id)?.privateState.grants ?? {},
        ).some((grant) => !!grant.refreshToken),
    };
    return authorization;
  };
  nativeDeviceViewSeams.authorization = projector;
  activation.onDispose(() => {
    lifetime.abort();
    release();
    if (nativeDeviceViewSeams.authorization === projector)
      nativeDeviceViewSeams.authorization = previous;
  });
}

export function bindProviderRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  bindLinearRuntime(ctx, activation);
  bindNativeRuntime(ctx, activation);
  bindNativeApiRuntime(activation);
  bindNativeModelRuntime(activation);
  bindNativeOAuthRuntime(activation);
  bindNativeCleanupRuntime(activation, ["vault", "openbao"]);
}
