/** Native header claims follow verified provider facts, without legacy token assumptions. */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { nativeDeviceViewSeams } from "@opensesame/app-core/lib/device-connector-view.js";
import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { tailscaleNodeAuthorization } from "@opensesame/app-core/lib/tailscale/browser-node-port.js";
import type { ConnectorTitleStatus } from "./SettingsPageStatus.js";
import { nativeVerificationClaim } from "./connect/native-connector-ui-values.js";

export type NativeHeaderStatus = ConnectorTitleStatus & { sentence: string };
function tailscaleHeader(
  connection: Connection | null,
): NativeHeaderStatus | null {
  if (connection && connection.providerId !== "tailscale") return null;
  const node = tailscaleNodeAuthorization();
  const id = connection?.connectionId ?? node?.connectionId;
  const row = readDeviceRows().find((entry) => entry.connectionId === id);
  if (
    connection &&
    connection.connectionRef !== `local/connector/${connection.connectionId}`
  )
    return null;
  if (
    row?.fields.native_configuration !== undefined &&
    row.fields.tailscale_browser_node === undefined
  )
    return null;
  const connected =
    !!node?.connected &&
    node.connectionId === id &&
    row?.fields.tailscale_browser_node !== undefined;
  return nodeHeader(connected);
}
function nodeHeader(connected: boolean): NativeHeaderStatus {
  return {
    tone: connected ? "ok" : "idle",
    label: connected ? "Browser node connected" : "Browser node not connected",
    sentence: connected
      ? "This browser node is authenticated to its tailnet."
      : "Connect this browser node to Tailscale.",
  };
}
function aiHeader(
  view: NativeConnectorView,
  provider: Provider,
  connectionId: string,
): NativeHeaderStatus {
  const current = nativeDeviceViewSeams.authorization(connectionId);
  return current?.status === "active" &&
    view.status === "connected" &&
    view.verifiedAt !== null
    ? verifiedHeader(view, provider)
    : {
        tone: "warn",
        label: "Verification pending",
        sentence:
          current?.statusDetail ??
          "Verify this AI connection in its owning vault.",
      };
}
function verifiedHeader(
  view: NativeConnectorView,
  provider: Provider,
): NativeHeaderStatus {
  if (view.configuration.method === "native-local")
    return {
      tone: "ok",
      label: "Browser configuration verified",
      sentence: "Browser configuration verified on this device.",
    };
  const identity = view.identity;
  let sentence = `${nativeVerificationClaim(provider.id, provider.displayName)}.`;
  let label =
    provider.id === "google-drive" ? "Account verified" : "Access verified";
  if (identity?.assurance === "account-verified") {
    sentence = `Account verified: ${identity.label}.`;
    if (provider.id !== "google-drive") label = "Connected";
  } else if (identity?.assurance === "workspace-verified") {
    sentence = `Workspace verified: ${identity.label}.`;
    label = "Connected";
  }
  if (view.grants.length) {
    const expiries = view.grants.flatMap((grant) =>
      grant.expiresAt === null ? [] : [grant.expiresAt],
    );
    sentence += expiries.length
      ? ` Next reported token expiry: ${new Date(Math.min(...expiries)).toISOString()}.`
      : " The provider did not report token expiry.";
  }
  return { tone: "ok", label, sentence };
}
export function nativeConnectorHeaderStatus(
  connection: Connection | null,
  provider: Provider,
): NativeHeaderStatus | null {
  if (provider.id === "tailscale") return tailscaleHeader(connection);
  if (
    !connection ||
    !readDeviceRows().some(
      (row) =>
        row.connectionId === connection.connectionId &&
        row.fields.native_configuration !== undefined,
    )
  )
    return null;
  const view = readNativeConnector(connection.connectionId);
  if (view?.configuration.parameters.ai_contract !== undefined)
    return aiHeader(view, provider, connection.connectionId);
  if (view && view.status !== "cleanup") {
    const policy = nativeBrowserMethodPolicy(
      view.providerId,
      view.configuration.method,
      view.configuration.parameters,
    );
    if (!policy.available)
      return {
        tone: "warn",
        label: "Browser route unavailable",
        sentence:
          policy.reason ??
          "This provider route is unavailable in this browser.",
      };
  }
  if (connection.status !== "active")
    return {
      tone: "warn",
      label: "Verification pending",
      sentence:
        connection.statusDetail ??
        "Provider verification is required before using this connection.",
    };
  if (!view || view.status !== "connected" || view.verifiedAt === null)
    return {
      tone: "warn",
      label: "Verification pending",
      sentence:
        "Provider verification is required before using this connection.",
    };
  return verifiedHeader(view, provider);
}
