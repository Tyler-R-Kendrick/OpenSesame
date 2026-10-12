import { assertNativeBrowserMcpPolicy } from "./native-browser-policy.js";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import {
  type NativeConfiguration,
  emptyNativePrivate,
  emptyNativeRuntime,
} from "./native-connector-schema.js";
import {
  loadNativeConnectorRecord,
  saveNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";
import { nativeMcpMetadataUnavailableReason } from "./native-mcp-availability.js";
import {
  MCP_CLASSIFICATION,
  nativeMcpConfigurationFingerprint,
  nativeMcpProviderMetadata,
  nativeMcpRecordBinding,
} from "./native-mcp-profile.js";
import { nativeOAuthGuard } from "./native-oauth-session.js";

function assertMcpInput(
  input: NativeDriverInput,
  parameters: Record<string, string>,
): void {
  if (input.method !== "mcp" || Object.keys(input.credentials).length)
    throw new Error(
      "MCP public browser routes do not accept confidential credentials",
    );
  if (
    Object.keys(parameters).some((name) => name !== "mcp_url") ||
    Object.keys(input.targetIds).length
  )
    throw new Error("Select a published provider MCP resource");
  if (Object.keys(input.requestedScopes).some((actor) => actor !== "user"))
    throw new Error("This MCP route supports delegated user permissions only");
}

function assertMcpUpdate(
  input: NativeDriverInput,
  saved: ReturnType<typeof loadNativeConnectorRecord>,
  configuration: NativeConfiguration,
): void {
  if (
    input.connectionId &&
    (!saved ||
      saved.configuration.providerId !== input.providerId ||
      saved.revision !== input.revision)
  )
    throw new Error("Connector changed; reload before saving");
  if (!saved) return;
  if (saved.configuration.method !== "mcp")
    throw new Error(
      "Create a separate connector for a different authentication method",
    );
  if (
    saved.configuration.fingerprint !== configuration.fingerprint &&
    (Object.keys(saved.privateState.grants).length ||
      Object.keys(saved.privateState.pending).length ||
      saved.privateState.recovery.length ||
      saved.privateState.credentials.mcp_client)
  )
    throw new Error(
      "Finish provider authorization cleanup before changing this connector binding",
    );
}

export async function configureNativeMcpConnector(
  input: NativeDriverInput,
  transport: NativeProviderTransport = nativeProviderTransport(),
) {
  transport.assertCurrent();
  assertNativeBrowserMcpPolicy(input.providerId);
  const { client_id: enteredClientId, ...parameters } = input.parameters;
  const clientId = enteredClientId?.trim();
  assertMcpInput(input, parameters);
  const metadata = nativeMcpProviderMetadata(
    input.providerId,
    parameters.mcp_url,
  );
  const unavailable = nativeMcpMetadataUnavailableReason(
    input.providerId,
    metadata,
  );
  if (unavailable) throw new Error(unavailable);
  const scopes = [...new Set(input.requestedScopes.user ?? [])].sort();
  if (
    scopes.some(
      (scope) => metadata.status !== "ok" || !metadata.scopes.includes(scope),
    )
  )
    throw new Error("Select permissions published by this MCP provider");
  const configuration: NativeConfiguration = {
    version: 1,
    providerId: input.providerId,
    method: "mcp",
    displayName: input.displayName.trim(),
    icon: input.icon ?? "",
    parameters: { mcp_url: metadata.url },
    requestedScopes: { user: scopes },
    targetIds: {},
    fingerprint: "0".repeat(64),
  };
  if (clientId) configuration.clientId = clientId;
  configuration.targetIds = {
    mcp: nativeMcpRecordBinding(configuration).resource,
  };
  configuration.fingerprint =
    await nativeMcpConfigurationFingerprint(configuration);
  transport.assertCurrent();
  const saved = input.connectionId
    ? loadNativeConnectorRecord(input.connectionId)
    : null;
  assertMcpUpdate(input, saved, configuration);
  if (!saved)
    return saveNativeConnector(
      {
        connectionId: `devconn_${crypto.randomUUID()}`,
        configuration,
        runtime: emptyNativeRuntime(),
        privateState: emptyNativePrivate(),
      },
      MCP_CLASSIFICATION,
    );
  return updateNativeConnector(
    saved.connectionId,
    nativeOAuthGuard(saved),
    MCP_CLASSIFICATION,
    (record) => {
      transport.assertCurrent();
      record.configuration = configuration;
      return record;
    },
  );
}
