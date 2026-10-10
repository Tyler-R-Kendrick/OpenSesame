import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
/** The card uses the same compiled provider admission as the connection page. */
import { connectorCardAction } from "@opensesame/app-core/lib/connector-action-capability.js";
import { readLinearConnector } from "@opensesame/app-core/lib/linear-store.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import { nativeSettingsDescriptor } from "./connect/NativeConnectorPanels.js";

function specializedRoute(providerId: string): boolean {
  return providerId === "linear";
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
  const descriptor = nativeSettingsDescriptor(provider);
  const routes = descriptor?.methods.map((method) => ({
    method: method.id,
    available: method.available,
  })) ?? [
    {
      method: "specialized" as const,
      available: specializedRoute(provider.id),
    },
  ];
  const now = Date.now();
  return connectorCardAction(provider, {
    routes,
    connection,
    nativeView: connection
      ? readNativeConnector(connection.connectionId)
      : null,
    specializedVerified: specializedProof(connection, now),
    nativeRequired:
      provider.category !== "wallet" &&
      !routes.some((route) => route.available),
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
