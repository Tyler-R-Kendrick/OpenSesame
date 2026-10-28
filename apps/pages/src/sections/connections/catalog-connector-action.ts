import { isAiConnectionProvider } from "@opensesame/app-core/lib/ai-connections/presets.js";
import { leadingUnavailableKind } from "@opensesame/app-core/lib/browser-disposition.js";
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
/** The card uses the same compiled provider admission as the connection page. */
import { connectorCardAction } from "@opensesame/app-core/lib/connector-action-capability.js";
import { readLinearConnector } from "@opensesame/app-core/lib/linear-store.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { isSecretBackendProvider } from "@opensesame/app-core/lib/secret-backends/presets.js";
import { nativeSettingsDescriptor } from "./connect/NativeConnectorPanels.js";
import { nativeMethodConfigurable } from "./connect/native-connector-ui.js";

function specializedRoute(providerId: string): boolean {
  return (
    ["linear", "aws-kms", "gcp-kms"].includes(providerId) ||
    isSecretBackendProvider(providerId) ||
    isAiConnectionProvider(providerId)
  );
}

function specializedProof(connection: Connection | null, now: number): boolean {
  if (!connection || connection.status !== "active") return false;
  if (connection.providerId === "linear") {
    const runtime = readLinearConnector(connection.connectionId);
    return [runtime?.app, runtime?.user].some(
      (identity) =>
        !!identity &&
        !identity.needsReauth &&
        !!identity.workspaceId &&
        (identity.expiresAt === null || identity.expiresAt > now),
    );
  }
  return false;
}

export function catalogConnectorAction(
  provider: Provider,
  connection: Connection | null,
) {
  const descriptor =
    isSecretBackendProvider(provider.id) || isAiConnectionProvider(provider.id)
      ? null
      : nativeSettingsDescriptor(provider);
  const nativeRoutes = descriptor?.methods.map((method) => ({
    method: method.id,
    available: method.available,
    configurable: nativeMethodConfigurable(method),
  })) ?? [
    {
      method: "specialized" as const,
      available: specializedRoute(provider.id),
      configurable: false,
    },
  ];
  // A Linear page still has its explicit advanced GraphQL/API-key fallback
  // when the MCP driver is unavailable in this browser runtime.
  const routes =
    provider.id === "linear" &&
    !nativeRoutes.some((route) => route.available || route.configurable)
      ? [
          ...nativeRoutes,
          {
            method: "specialized" as const,
            available: specializedRoute(provider.id),
            configurable: false,
          },
        ]
      : nativeRoutes;
  const now = Date.now();
  const unavailableKind = descriptor
    ? leadingUnavailableKind(
        descriptor.methods
          .filter((method) => !method.available)
          .map((method) => method.unavailableKind),
      )
    : undefined;
  return connectorCardAction(provider, {
    routes,
    connection,
    nativeView: connection
      ? readNativeConnector(connection.connectionId)
      : null,
    specializedVerified: specializedProof(connection, now),
    // Only a provider reached through a native client is "a desktop app away".
    nativeRequired:
      !routes.some((route) => route.available) &&
      unavailableKind === "companion",
    unavailableKind,
    now,
  });
}

/** A cosmetic legacy row must never shadow an actually verified browser binding. */
export function preferredCatalogConnection(
  provider: Provider,
  connections: readonly Connection[],
) {
  const matching = connections.filter(
    (row) => row.providerId === provider.id && row.status !== "revoked",
  );
  return (
    matching.find(
      (row) => catalogConnectorAction(provider, row).kind === "configure",
    ) ??
    matching.find(
      (row) => catalogConnectorAction(provider, row).kind === "resume",
    ) ??
    matching[0] ??
    null
  );
}
