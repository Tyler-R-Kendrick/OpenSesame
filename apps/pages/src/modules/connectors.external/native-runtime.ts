/** Native browser providers share the owning capability's lease and declared egress purpose. */
import { aiConnectionProjection } from "@opensesame/app-core/lib/ai-connections/projection.js";
import { NATIVE_PROVIDER_PURPOSE } from "@opensesame/app-core/lib/capabilities/catalog-always-on.js";
import { EgressDenied } from "@opensesame/app-core/lib/capabilities/egress.js";
import type { ApprovedCapabilityContext } from "@opensesame/app-core/lib/capabilities/runtime-contract.js";
import { compositionStore } from "@opensesame/app-core/lib/capabilities/store.js";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import { bindNativeBrowserPolicyOrigin } from "@opensesame/app-core/lib/native-browser-policy.js";
import { nativeConfigurationBrowserPolicy } from "@opensesame/app-core/lib/native-configuration-policy.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "@opensesame/app-core/lib/native-connector-store.js";
import {
  type NativeProviderSocket,
  type NativeProviderTransport,
  bindNativeProviderTransport,
} from "@opensesame/app-core/lib/native-connector-transport.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { type Activation, createActivation } from "../activation.js";
import { LeaseAbortedError, anySignal, runUnlessAborted } from "../signals.js";
import { bindBridgeRuntime, carriedByBridge } from "./bridge-runtime.js";
import { captureBrowserNodeTransport } from "./browser-node-transport.js";
import { bindLinearRuntime } from "./linear-runtime.js";
import { bindNativeApiRuntime } from "./native-api-runtime.js";
import { bindNativeCatalogConfigurationRuntime } from "./native-catalog-configuration-runtime.js";
import { bindNativeCleanupRuntime } from "./native-cleanup-runtime.js";
import { bindNativeModelKeys } from "./native-model-keys-runtime.js";
import { bindNativeModelRuntime } from "./native-model-runtime.js";
import { bindNativeOAuthRuntime } from "./native-oauth-runtime.js";
import { bindNativeTwitchValidation } from "./native-twitch-validation.js";
import { bindNativeVaultRuntime } from "./native-vault-runtime.js";
import { bindSessionConnections } from "./session-connections-runtime.js";

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
function connectionPolicy(id: string, view: NativeConnectorView) {
  const ai = aiConnectionProjection(id);
  if (ai === "ordinary")
    return nativeConfigurationBrowserPolicy(
      view.providerId,
      view.configuration.method,
      view.configuration.parameters,
    );
  return {
    available: ai === "verified",
    reason: "Verify this AI connection in its owning vault.",
  };
}

/** How a device-connector view reads a native connection, for as long as this lease and activation hold. */
function authorizationProjector(
  signal: AbortSignal,
  activation: Activation,
): typeof nativeDeviceViewSeams.authorization {
  return (id) => {
    if (signal.aborted || activation.disposed()) return null;
    const view = readNativeConnector(id);
    if (!view) return null;
    const policy = connectionPolicy(id, view);
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
}

function openNativeSocket(
  ctx: ApprovedCapabilityContext,
  url: URL,
  protocols: readonly string[],
  signal: AbortSignal,
  ownerCurrent: () => void,
): NativeProviderSocket {
  const href = url.href;
  const decide = ctx.egress.decideWebSocket;
  if (!decide) throw new Error("This capability has no WebSocket transport");
  const meta = {
    capability: "connectors.external",
    purpose: NATIVE_PROVIDER_PURPOSE,
  };
  let withdrawn = false;
  const assertCurrent = () => {
    ownerCurrent();
    signal.throwIfAborted();
    if (withdrawn) throw new LeaseAbortedError();
    const decision = decide(href, meta);
    if (!decision.ok)
      throw new EgressDenied(
        decision.code,
        "connectors.external",
        decision.destination,
      );
  };
  assertCurrent();
  const socket = new WebSocket(href, [...protocols]);
  const withdraw = () => {
    if (withdrawn) return;
    withdrawn = true;
    socket.close(1000, "Operation ended");
  };
  const unsubscribe = compositionStore.subscribe(() => {
    try {
      assertCurrent();
    } catch {
      withdraw();
    }
  });
  signal.addEventListener("abort", withdraw, { once: true });
  socket.addEventListener(
    "close",
    () => {
      signal.removeEventListener("abort", withdraw);
      unsubscribe();
    },
    { once: true },
  );
  if (signal.aborted) withdraw();
  return { socket, assertCurrent };
}

export function bindNativeRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  activation.onDispose(
    bindNativeBrowserPolicyOrigin(() => window.location.origin),
  );
  const lifetime = new AbortController();
  const signal = anySignal([ctx.lease.signal, lifetime.signal]);
  const assertCurrent = () => {
    if (
      signal.aborted ||
      activation.disposed() ||
      !vaultStore.isGenuineSession()
    )
      throw new LeaseAbortedError();
  };
  const transport: NativeProviderTransport = {
    assertCurrent,
    signal,
    openWebSocket: (url, protocols, callerSignal) =>
      openNativeSocket(
        ctx,
        url,
        protocols,
        callerSignal ? anySignal([signal, callerSignal]) : signal,
        assertCurrent,
      ),
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
      // A token exchange is carried like any other call to a host the bridge
      // holds (ADR 0217); the lease is not part of its signal, so a complete
      // late answer can still be sealed and cleaned up.
      const carried = carriedByBridge(ctx, request, requestSignal);
      if (carried) return carried;
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
      const carried = carriedByBridge(ctx, request, requestSignal);
      if (carried) return carried;
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
  };
  transport.capture = () => captureBrowserNodeTransport(transport, ctx);
  const release = bindNativeProviderTransport(transport);
  bindBridgeRuntime(activation);
  const previous = nativeDeviceViewSeams.authorization;
  const projector = authorizationProjector(signal, activation);
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
  let session: Activation | undefined;
  const retire = () => {
    session?.dispose();
    session = undefined;
  };
  const sync = () => {
    if (activation.disposed() || !vaultStore.isGenuineSession()) {
      retire();
      return;
    }
    if (session) return;
    const owned = createActivation(ctx, "connectors.external:owner");
    session = owned;
    try {
      bindGenuineProviderRuntime(ctx, owned);
    } catch (error) {
      retire();
      throw error;
    }
  };
  const stopLock = vaultStore.onLock(retire);
  const stopChanges = vaultStore.subscribe(sync);
  activation.onDispose(() => {
    stopLock();
    stopChanges();
    retire();
  });
  sync();
}
function bindGenuineProviderRuntime(
  ctx: ApprovedCapabilityContext,
  activation: Activation,
): void {
  bindLinearRuntime(ctx, activation);
  bindNativeRuntime(ctx, activation);
  bindNativeApiRuntime(activation);
  bindNativeModelRuntime(activation);
  bindNativeModelKeys(activation);
  bindSessionConnections(activation);
  bindNativeOAuthRuntime(activation);
  bindNativeTwitchValidation(activation);
  bindNativeVaultRuntime(activation);
  bindNativeCatalogConfigurationRuntime(activation);
  bindNativeCleanupRuntime(activation, ["vault", "openbao", "github", "s3"]);
}
