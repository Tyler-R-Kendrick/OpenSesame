import { captureNativeAuthorizationTransport } from "./native-authorization-transport.js";
/** The native common driver returns actual configured resource data, never a key-check placeholder. */
import { cancelNativeBrowserConsent } from "./native-browser-oauth-cancel.js";
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import {
  type NativeCleanupOutcome,
  retryNativeConnectorCleanup,
} from "./native-connector-lifecycle.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { invokeNativeMcpAction } from "./native-mcp-connectors.js";
import {
  nativeOAuthBrowserPort,
  optionalNativeOAuthBrowserPort,
} from "./native-oauth-browser-port.js";
import { discardSupersededNativeOAuthClientSecret } from "./native-oauth-client-cleanup.js";
import {
  type NativeOAuthClientOwner,
  assertNativeOAuthClientOwner,
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  discardNativeOAuthClientSecret,
  nativeOAuthClientClassification,
  nativeOAuthClientTarget,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import {
  invokeNativeOAuthMcpTool,
  listNativeOAuthMcpTools,
  verifyNativeOAuthMcpResource,
} from "./native-oauth-mcp-operations.js";
import { verifyNativeOAuthResource } from "./native-oauth-resource.js";
import {
  requireNativeOAuthRecord,
  retryRetainedNativeOAuthGrants,
} from "./native-oauth-session.js";

export type NativeOAuthResourceOwner = NativeOAuthClientOwner & {
  close(): void;
};
export type NativeOAuthResourceDriverPorts = {
  supports(providerId: string): boolean;
  /** Capture the original authority synchronously, then await only its custody work. */
  capture(
    signal?: AbortSignal,
    original?: NativeProviderTransport,
  ): NativeOAuthResourceOwner | Promise<NativeOAuthResourceOwner>;
};
function resourceOperations(
  ports: NativeOAuthResourceDriverPorts,
  consent = false,
) {
  return async <T>(
    action: (owner: NativeOAuthClientOwner) => Promise<T>,
    caller?: AbortSignal,
    original?: NativeProviderTransport,
  ): Promise<T> => {
    caller?.throwIfAborted();
    const guard = consent
      ? optionalNativeOAuthBrowserPort()?.captureAuthorizationGuard?.()
      : undefined;
    guard?.();
    const pending = original
      ? ports.capture(caller, original)
      : caller
        ? ports.capture(caller)
        : ports.capture();
    const capture = await pending;
    try {
      caller?.throwIfAborted();
      const original = consent
        ? captureNativeAuthorizationTransport(capture.transport, () =>
            guard?.(),
          )
        : capture.transport;
      const signal = caller
        ? AbortSignal.any([
            caller,
            ...(original.signal ? [original.signal] : []),
          ])
        : original.signal;
      const assertCurrent = () => {
        signal?.throwIfAborted();
        original.assertCurrent();
        signal?.throwIfAborted();
      };
      const transport: NativeProviderTransport = {
        ...original,
        fetch: original.fetch.bind(original),
        signal,
        assertCurrent,
      };
      if (original.settleCredentialMutation)
        transport.settleCredentialMutation =
          original.settleCredentialMutation.bind(original);
      const owner = { ...capture, transport };
      assertNativeOAuthClientOwner(owner);
      return await action(owner);
    } finally {
      capture.close();
    }
  };
}
function isMcp(id: string) {
  return (
    nativeOAuthClientTarget(requireNativeOAuthRecord(id).configuration)
      .resource_protocol === "mcp"
  );
}
const verifyResource = (id: string, owner: NativeOAuthClientOwner) =>
  isMcp(id)
    ? verifyNativeOAuthMcpResource(id, owner)
    : verifyNativeOAuthResource(id, owner);
function resourceReadResult(
  result: Awaited<ReturnType<typeof verifyNativeOAuthResource>>,
) {
  return {
    label: "Configured API resource read",
    items: [
      {
        id: nativeOAuthClientTarget(result.view.configuration).resource ?? "",
        label: "Resource response",
        secretValue: JSON.stringify(result.body, null, 2),
      },
    ],
  };
}
function nativeOAuthResourceCleanup(
  owned: ReturnType<typeof resourceOperations>,
): NativeConnectorDriver["cleanup"] {
  return {
    classification: nativeOAuthClientClassification,
    prepare: (id, original) =>
      owned(
        async (owner) => {
          assertNativeOAuthClientOwner(owner);
          await retryRetainedNativeOAuthGrants(id);
          const record = requireNativeOAuthRecord(id);
          if (
            record.privateState.recovery.length === 0 &&
            Object.keys(record.privateState.grants).length === 0 &&
            Object.keys(record.privateState.pending).length === 0
          )
            await discardNativeOAuthClientSecret(id, owner);
        },
        undefined,
        original,
      ),
    finalize: (id, original) =>
      owned(
        async (owner) => {
          assertNativeOAuthClientOwner(owner);
          await discardNativeOAuthClientSecret(id, owner);
        },
        undefined,
        original,
      ),
    cleanup: (obligation, context) =>
      owned<NativeCleanupOutcome>(
        async (owner) => {
          assertNativeOAuthClientOwner(owner);
          const record = requireNativeOAuthRecord(context.connectionId);
          if (record.privateState.credentials.oauth_client_vault !== owner.tomb)
            throw new NativeOAuthError("expired");
          if (!obligation.grant && obligation.credentials?.phase === "exchange")
            throw new NativeOAuthError("cleanup");
          if (obligation.credentials?.phase === "superseded")
            await discardSupersededNativeOAuthClientSecret(
              obligation,
              context.connectionId,
              owner,
            );
          else if (
            obligation.kind === "revoke" &&
            record.privateState.recovery.length === 1 &&
            Object.keys(record.privateState.grants).length === 0 &&
            Object.keys(record.privateState.pending).length === 0
          )
            await discardNativeOAuthClientSecret(context.connectionId, owner);
          return "local-credential-forgotten";
        },
        undefined,
        context.transport,
      ),
  };
}

export function createNativeOAuthResourceDriver(
  ports: NativeOAuthResourceDriverPorts,
): NativeConnectorDriver {
  const owned = resourceOperations(ports);
  const consentOwned = resourceOperations(ports, true);
  return {
    supports: ports.supports,
    configure: (input) =>
      owned((owner) => {
        if (!input.parameters.resource) throw new NativeOAuthError("callback");
        return configureNativeOAuthClient(input, owner);
      }),
    authorize: (id, actor = "user") => {
      const browser = nativeOAuthBrowserPort();
      return consentOwned(async (owner) => {
        if (actor !== "user") throw new NativeOAuthError("scope");
        if (
          requireNativeOAuthRecord(id).privateState.recovery.some(
            (entry) => entry.credentials?.phase === "superseded",
          )
        )
          await retryNativeConnectorCleanup(id, owner.transport);
        const url = await beginNativeOAuthClient(id, owner);
        const record = requireNativeOAuthRecord(id);
        const pending = record.privateState.pending.user;
        if (!pending || !browser.authorize)
          throw new NativeOAuthError("callback");
        try {
          const callback = await browser.authorize(url, {
            state: pending.state,
            expiresAt: pending.expiresAt,
            redirectUri: pending.redirectUri,
            signal: owner.transport.signal,
          });
          await exchangeNativeOAuthClient(callback, owner);
          await verifyResource(id, owner);
        } catch (error) {
          await cancelNativeBrowserConsent(
            id,
            pending.state,
            nativeOAuthClientClassification(),
          );
          throw error;
        }
      });
    },
    verify: (id) =>
      owned(async (owner) => (await verifyResource(id, owner)).view),
    invoke: (id, operation, input, signal) =>
      owned(async (owner) => {
        if (isMcp(id))
          return invokeNativeMcpAction(operation, input, {
            list: () => listNativeOAuthMcpTools(id, owner),
            call: (name, args) =>
              invokeNativeOAuthMcpTool(id, name, args, owner),
          });
        if (operation !== "provider.resource.read" || Object.keys(input).length)
          throw new NativeOAuthError("scope");
        const result = await verifyNativeOAuthResource(id, owner);
        return resourceReadResult(result);
      }, signal),
    cleanup: nativeOAuthResourceCleanup(owned),
  };
}
