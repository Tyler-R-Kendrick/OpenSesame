/** Browser admission follows the central audited route, including public site and token choices. */
import {
  type BridgeGuidance,
  bridgeGuidance,
} from "@opensesame/app-core/lib/native-bridge.js";
import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeMethodForEdit } from "./native-connector-edit-values.js";
import { nativeFieldValues } from "./native-connector-ui-values.js";
import type {
  NativeFieldValues,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

/** Where the bridge is explained; the extension's own README, which says what it can and cannot do. */
export const CONNECTOR_BRIDGE_DOCS =
  "https://github.com/Tyler-R-Kendrick/OpenSesame/blob/main/apps/browser-extension-bridge/README.md";

/** What a person does next so the bridge can carry this provider. */
export function bridgeGuidanceText(guidance: BridgeGuidance): string {
  const hosts = guidance.hosts.join(", ");
  return guidance.state === "needs-host"
    ? `The OpenSesame connector bridge is on. Open it and allow ${hosts}; this connects once you have.`
    : `The OpenSesame connector bridge can make this call from your browser: install it, switch it on for this site, then allow ${hosts} in it.`;
}

export function nativePolicyMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  parameters: Readonly<Record<string, string>> = {},
): NativeMethodDescriptor {
  const policy = nativeBrowserMethodPolicy(providerId, method.id, parameters);
  if (policy.available) return method;
  const guidance = method.id === "api-key" ? bridgeGuidance(providerId) : null;
  const reason =
    policy.reason ?? "This provider route is unavailable in this browser.";
  return {
    ...method,
    available: false,
    unavailableKind: "refuses-browser",
    unavailableReason: guidance
      ? `${reason} ${bridgeGuidanceText(guidance)}`
      : reason,
    links: guidance
      ? [
          ...(method.links ?? []),
          { label: "Connector bridge", url: CONNECTOR_BRIDGE_DOCS },
        ]
      : method.links,
  };
}

export function nativeDraftMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  view: NativeConnectorView | null | undefined,
  values: NativeFieldValues,
): NativeMethodDescriptor {
  return nativePolicyMethod(
    providerId,
    nativeMethodForEdit(method, view, values),
    nativeFieldValues(method.fields, values, false),
  );
}
