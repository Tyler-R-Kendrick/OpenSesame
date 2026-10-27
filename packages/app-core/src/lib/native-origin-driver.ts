import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
import { cancelNativeBrowserConsent } from "./native-browser-oauth-cancel.js";
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  nativeOAuthBrowserPort,
  optionalNativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  requireNativeOAuthRecord,
  retryRetainedNativeOAuthGrants,
} from "./native-oauth-session.js";
import {
  discardNativeOriginKey,
  prepareNativeOriginKeyCleanup,
} from "./native-origin-cleanup.js";
import {
  type NativeOriginOwner,
  ORIGIN_PROVIDER_ID,
  assertNativeOriginPolicy,
  beginNativeOrigin,
  configureNativeOrigin,
  nativeOriginClassification,
} from "./native-origin-configuration.js";
import { exchangeNativeOriginInstallation } from "./native-origin-exchange.js";
import { verifyNativeOriginResource } from "./native-origin-resource.js";

export type NativeOriginDriverOwner = NativeOriginOwner & { close(): void };
export type NativeOriginDriverPorts = {
  capture(
    signal?: AbortSignal,
    original?: NativeProviderTransport,
  ): NativeOriginDriverOwner | Promise<NativeOriginDriverOwner>;
};
function operations(ports: NativeOriginDriverPorts, consent = false) {
  return async <T>(
    action: (owner: NativeOriginOwner) => Promise<T>,
    caller?: AbortSignal,
    original?: NativeProviderTransport,
  ): Promise<T> => {
    caller?.throwIfAborted();
    const guard = consent
      ? optionalNativeOAuthBrowserPort()?.captureAuthorizationGuard?.()
      : undefined;
    guard?.();
    const capture = await ports.capture(caller, original);
    try {
      caller?.throwIfAborted();
      const authorized = consent
        ? captureNativeAuthorizationTransport(capture.transport, () =>
            guard?.(),
          )
        : capture.transport;
      const signal = caller
        ? AbortSignal.any([
            caller,
            ...(authorized.signal ? [authorized.signal] : []),
          ])
        : authorized.signal;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        authorized.assertCurrent();
        signal?.throwIfAborted();
      };
      const transport: NativeProviderTransport = {
        ...authorized,
        fetch: authorized.fetch.bind(authorized),
        signal,
        assertCurrent,
      };
      if (authorized.settleCredentialMutation)
        transport.settleCredentialMutation =
          authorized.settleCredentialMutation.bind(authorized);
      const owner = { ...capture, transport };
      owner.transport.assertCurrent();
      return await action(owner);
    } finally {
      capture.close();
    }
  };
}
async function authorizeOrigin(
  id: string,
  owner: NativeOriginOwner,
): Promise<void> {
  const existing = requireNativeOAuthRecord(id);
  const active = existing.privateState.grants.user;
  const metadata = existing.runtime.grants.find(
    (grant) => grant.actor === "user",
  );
  if (
    active &&
    !metadata?.needsReauth &&
    !existing.privateState.recovery.length &&
    !Object.keys(existing.privateState.pending).length
  ) {
    await verifyNativeOriginResource(id, owner);
    return;
  }
  if (
    existing.privateState.recovery.some(
      (entry) => entry.credentials?.phase === "superseded",
    )
  )
    await retryNativeConnectorCleanup(id, owner.transport);
  const browser = nativeOAuthBrowserPort();
  const url = await beginNativeOrigin(id, owner);
  const pending = requireNativeOAuthRecord(id).privateState.pending.user;
  if (!pending || !browser.authorize) throw new NativeOAuthError("callback");
  try {
    const callback = await browser.authorize(url, {
      state: pending.state,
      expiresAt: pending.expiresAt,
      redirectUri: pending.redirectUri,
      signal: owner.transport.signal,
    });
    await exchangeNativeOriginInstallation(callback, owner);
    await verifyNativeOriginResource(id, owner);
  } catch (error) {
    await cancelNativeBrowserConsent(
      id,
      pending.state,
      nativeOriginClassification(),
    );
    throw error;
  }
}

export function createNativeOriginDriver(
  ports: NativeOriginDriverPorts,
): NativeConnectorDriver {
  const owned = operations(ports);
  const consentOwned = operations(ports, true);
  return {
    supports: (id) => id === ORIGIN_PROVIDER_ID,
    configure: (input) => owned((owner) => configureNativeOrigin(input, owner)),
    authorize: (id, actor = "user") =>
      consentOwned(async (owner) => {
        if (actor !== "user") throw new NativeOAuthError("scope");
        await authorizeOrigin(id, owner);
      }),
    verify: (id) =>
      owned(
        async (owner) => (await verifyNativeOriginResource(id, owner)).view,
      ),
    invoke: (id, operation, input, signal) =>
      owned(async (owner) => {
        if (operation !== "provider.read" || Object.keys(input).length)
          throw new NativeOAuthError("scope");
        const result = await verifyNativeOriginResource(id, owner);
        return {
          label: "Origin installation rate limit verified",
          items: [
            { id: "limit", label: `Limit: ${result.body.limit}` },
            { id: "remaining", label: `Remaining: ${result.body.remaining}` },
            { id: "reset", label: `Reset: ${result.body.reset}` },
            { id: "used", label: `Used: ${result.body.used}` },
          ],
        };
      }, signal),
    cleanup: {
      classification: nativeOriginClassification,
      credentialSlots: ["origin_app_reference", "origin_app_vault"],
      prepare: (id, original) =>
        owned(
          async (owner) => {
            await retryRetainedNativeOAuthGrants(id);
            await prepareNativeOriginKeyCleanup(
              id,
              owner,
              nativeOriginClassification(),
            );
          },
          undefined,
          original,
        ),
      finalize: (id, original) =>
        owned(
          (owner) =>
            prepareNativeOriginKeyCleanup(
              id,
              owner,
              nativeOriginClassification(),
            ),
          undefined,
          original,
        ),
      cleanup: (obligation, context) =>
        owned(
          (owner) =>
            discardNativeOriginKey(obligation, context, owner, () =>
              assertNativeOriginPolicy(context.configuration, owner),
            ),
          undefined,
          context.transport,
        ),
    },
  };
}
