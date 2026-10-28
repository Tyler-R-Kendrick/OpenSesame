import { subscribeDeviceRows } from "./device-connector-records.js";
/** Configured MCP proves protocol/tool access without fabricating OAuth authorization. */
import { assertNativeConfigurationPolicy } from "./native-configuration-policy.js";
import type { NativeConnectorDriver } from "./native-connector-drivers.js";
import { retryNativeConnectorCleanup } from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  updateNativeConnector,
} from "./native-connector-store.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import {
  discardActiveConfiguredMcpCredential,
  discardSupersededConfiguredMcpCredential,
} from "./native-mcp-configured-cleanup.js";
import {
  type ConfiguredMcpOwner,
  type ConfiguredMcpParameters,
  assertConfiguredMcpOwner,
  configureMcpCredentials,
  configuredMcpBinding,
  configuredMcpClassification,
  configuredMcpCredentials,
  configuredMcpCredentialsForWithdrawal,
  configuredMcpFingerprint,
  configuredMcpTarget,
  isConfiguredMcp,
  supportsConfiguredMcp,
} from "./native-mcp-configured-config.js";
import { invokeNativeMcpAction } from "./native-mcp-connectors.js";
import {
  type NativeMcpDiscovery,
  NativeMcpSession,
  type NativeMcpToolResult,
} from "./native-mcp-protocol.js";
import {
  type NativeMcpBinding,
  NativeMcpError,
  admitNativeMcpRequest,
  nativeMcpUrl,
} from "./native-mcp-target.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";
import {
  assertVaultCredentials,
  initializeVaultCredentialCustody,
} from "./vault-credential-custody.js";
import { vaultStore } from "./vault/store.js";
export type ConfiguredMcpPorts = {
  capture(
    signal?: AbortSignal,
    original?: NativeProviderTransport,
  ): Promise<ConfiguredMcpOwner>;
};
function recordFor(id: string) {
  const record = loadNativeConnectorRecord(id);
  if (!record || !isConfiguredMcp(record.configuration))
    throw new NativeMcpError("target");
  return record;
}
function admit(
  owner: ConfiguredMcpOwner,
  configuration: Parameters<typeof assertNativeConfigurationPolicy>[0],
) {
  assertConfiguredMcpOwner(owner);
  assertNativeConfigurationPolicy(configuration, owner.transport);
  assertConfiguredMcpOwner(owner);
}
type ConfiguredMcpRequest = {
  binding: NativeMcpBinding;
  target: ConfiguredMcpParameters;
  owner: ConfiguredMcpOwner;
  token: string | undefined;
  signal: AbortSignal;
  check: () => void;
};
function authenticatedMcpFetch(port: ConfiguredMcpRequest): typeof fetch {
  return (input, init) => {
    port.check();
    const request = new Request(input, init);
    admitNativeMcpRequest(
      port.binding,
      nativeMcpUrl(request.url),
      request.method,
    );
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    if (port.target.mcp_authentication === "bearer")
      headers.set("authorization", `Bearer ${port.token}`);
    if (
      port.target.mcp_authentication === "header" &&
      port.target.mcp_header &&
      port.token
    )
      headers.set(port.target.mcp_header, port.token);
    port.check();
    return port.owner.transport.fetch(request, {
      headers,
      signal: AbortSignal.any([port.signal, request.signal]),
    });
  };
}
async function resource(id: string, owner: ConfiguredMcpOwner) {
  const record = recordFor(id);
  const configuration = record.configuration;
  if (
    configuration.fingerprint !==
      (await configuredMcpFingerprint(configuration)) ||
    Object.values(configuration.requestedScopes).some((scopes) => scopes.length)
  )
    throw new NativeMcpError("target");
  const target = configuredMcpTarget(configuration.parameters);
  if (configuration.targetIds.mcp !== target.mcp_resource)
    throw new NativeMcpError("target");
  const binding = configuredMcpBinding(configuration);
  const held = configuredMcpCredentials(
    configuration,
    record.privateState.credentials,
    owner,
  );
  const token = held.fields.get("mcpToken");
  if (target.mcp_authentication !== "anonymous" && !token)
    throw new NativeMcpError("authorization");
  if (target.mcp_authentication === "anonymous" && held.fields.size)
    throw new NativeMcpError("target");
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    lifetime.signal,
    owner.transport.signal ?? AbortSignal.abort(),
  ]);
  const check = () => {
    signal.throwIfAborted();
    admit(owner, configuration);
    const actual = recordFor(id);
    if (
      actual.revision !== record.revision ||
      actual.configuration.fingerprint !== binding.fingerprint
    )
      throw new NativeMcpError("disposed");
    assertVaultCredentials(held, owner.tomb, () =>
      assertConfiguredMcpOwner(owner),
    );
  };
  check();
  const invalidate = () => {
    try {
      check();
    } catch {
      lifetime.abort();
    }
  };
  const stopRows = subscribeDeviceRows(invalidate);
  const stopVault = vaultStore.subscribe(invalidate);
  const refusal = async () => {
    check();
    await updateNativeConnector(
      id,
      nativeOAuthGuard(record),
      configuredMcpClassification(),
      (current) => {
        check();
        current.privateState.verification = null;
        current.runtime.verifiedAt = null;
        return current;
      },
      check,
    );
  };
  const session = new NativeMcpSession(binding, {
    assertCurrent: check,
    accessGrant: async () => null,
    authorizationRequired: refusal,
    fetch: authenticatedMcpFetch({
      binding,
      target,
      owner,
      token,
      signal,
      check,
    }),
  });
  return {
    record,
    binding,
    session,
    check,
    privateResult(value: NativeMcpDiscovery | NativeMcpToolResult) {
      check();
      if (
        token &&
        JSON.stringify(value).includes(JSON.stringify(token).slice(1, -1))
      )
        throw new NativeMcpError("response");
    },
    async close() {
      lifetime.abort();
      stopRows();
      stopVault();
      await session.dispose();
    },
  };
}
async function verify(id: string, owner: ConfiguredMcpOwner) {
  const active = await resource(id, owner);
  try {
    const discovery = await active.session.connect();
    active.privateResult(discovery);
    active.check();
  } finally {
    await active.close();
  }
  admit(owner, active.record.configuration);
  const held = configuredMcpCredentials(
    active.record.configuration,
    active.record.privateState.credentials,
    owner,
  );
  const check = () =>
    assertVaultCredentials(held, owner.tomb, () =>
      admit(owner, active.record.configuration),
    );
  return updateNativeConnector(
    id,
    nativeOAuthGuard(active.record),
    configuredMcpClassification(),
    (current) => {
      check();
      const verifiedAt = Math.max(
        Date.now(),
        (current.runtime.verifiedAt ?? 0) + 1,
      );
      current.privateState.verification = {
        fingerprint: active.binding.fingerprint,
        verifiedAt,
        kind: "provider",
      };
      current.runtime = {
        verifiedAt,
        identity: null,
        targets: [
          {
            id: active.binding.resource,
            label: active.binding.resource,
            kind: "mcp-resource",
          },
        ],
        grants: [],
      };
      return current;
    },
    check,
  );
}
function configuredMcpOperations(ports: ConfiguredMcpPorts) {
  return async <T>(
    action: (owner: ConfiguredMcpOwner) => Promise<T>,
    signal?: AbortSignal,
    original?: NativeProviderTransport,
  ) => {
    signal?.throwIfAborted();
    const pending = ports.capture(signal, original);
    const captured = await pending;
    try {
      signal?.throwIfAborted();
      const original = captured.transport;
      if (!original.signal) throw new NativeMcpError("disposed");
      const lifetime = AbortSignal.any([
        ...(original.signal ? [original.signal] : []),
        ...(signal ? [signal] : []),
      ]);
      const owner = Object.freeze({
        ...captured,
        transport: Object.freeze({
          ...original,
          signal: lifetime,
          assertCurrent: () => {
            lifetime.throwIfAborted();
            original.assertCurrent();
            lifetime.throwIfAborted();
          },
        }),
      });
      assertConfiguredMcpOwner(owner);
      await initializeVaultCredentialCustody();
      assertConfiguredMcpOwner(owner);
      return await action(owner);
    } finally {
      captured.close();
    }
  };
}
export function createConfiguredMcpDriver(
  ports: ConfiguredMcpPorts,
): NativeConnectorDriver {
  const owned = configuredMcpOperations(ports);
  return {
    supports: supportsConfiguredMcp,
    configure: (input) =>
      owned(async (owner) => {
        const view = await configureMcpCredentials(
          input,
          owner,
          (configuration) => admit(owner, configuration),
        );
        const verified = await verify(view.connectionId, owner);
        if (!recordFor(view.connectionId).privateState.recovery.length)
          return verified;
        return retryNativeConnectorCleanup(view.connectionId, owner.transport);
      }),
    verify: (id) => owned((owner) => verify(id, owner)),
    invoke: (id, operation, input, signal) =>
      owned(async (owner) => {
        const record = recordFor(id);
        if (
          !record.privateState.verification ||
          record.runtime.verifiedAt === null ||
          record.privateState.recovery.length ||
          Object.keys(record.privateState.grants).length ||
          Object.keys(record.privateState.pending).length
        )
          throw new NativeMcpError("authorization");
        const active = await resource(id, owner);
        try {
          return await invokeNativeMcpAction(operation, input, {
            list: async () => {
              const result = await active.session.connect();
              active.privateResult(result);
              return result;
            },
            call: async (name, args) => {
              const discovery = await active.session.connect();
              active.privateResult(discovery);
              const result = await active.session.callTool(
                name,
                args,
                owner.transport.signal,
              );
              active.privateResult(result);
              return result;
            },
          });
        } finally {
          await active.close();
        }
      }, signal),
    cleanup: {
      classification: configuredMcpClassification,
      prepare: (id, original) =>
        owned(
          async (owner) => {
            const record = recordFor(id);
            admit(owner, record.configuration);
            configuredMcpCredentialsForWithdrawal(
              record.configuration,
              record.privateState.credentials,
              owner,
            );
          },
          undefined,
          original,
        ),
      finalize: (id, original) =>
        owned(
          async (owner) => {
            const record = recordFor(id);
            admit(owner, record.configuration);
            await discardActiveConfiguredMcpCredential(id, owner);
          },
          undefined,
          original,
        ),
      cleanup: (obligation, context) =>
        owned(
          async (owner) => {
            const record = recordFor(context.connectionId);
            admit(owner, record.configuration);
            return discardSupersededConfiguredMcpCredential(
              obligation,
              context.connectionId,
              owner,
            );
          },
          undefined,
          context.transport,
        ),
    },
  };
}
