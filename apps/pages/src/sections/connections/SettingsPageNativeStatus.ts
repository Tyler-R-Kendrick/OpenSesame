/** Native header claims follow verified provider facts, without legacy token assumptions. */
import type {
  Connection,
  Provider,
} from "@opensesame/app-core/lib/connections.js";
import { readDeviceRows } from "@opensesame/app-core/lib/device-connector-records.js";
import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import { readNativeConnector } from "@opensesame/app-core/lib/native-connector-store.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import type { ConnectorTitleStatus } from "./SettingsPageStatus.js";

export type NativeHeaderStatus = ConnectorTitleStatus & { sentence: string };
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
  let sentence = `${provider.displayName} access verified.`;
  let label = "Access verified";
  if (identity?.assurance === "account-verified") {
    sentence = `Account verified: ${identity.label}.`;
    label = "Connected";
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
