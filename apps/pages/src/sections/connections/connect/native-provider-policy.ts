/** Browser admission follows the central audited route, including public site and token choices. */
import {
  BRIDGE_README_URL,
  bridgeOAuthAdvice,
} from "@opensesame/app-core/lib/native-bridge.js";
import type { NativeBrowserPolicyDecision } from "@opensesame/app-core/lib/native-browser-policy.js";
import { nativeConfigurationBrowserPolicy } from "@opensesame/app-core/lib/native-configuration-policy.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeMethodForEdit } from "./native-connector-edit-values.js";
import { nativeFieldValues } from "./native-connector-ui-values.js";
import type {
  NativeFieldValues,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

function withAdvice(
  method: NativeMethodDescriptor,
  policy: NativeBrowserPolicyDecision,
): NativeMethodDescriptor {
  if (!policy.advice) return method;
  const links = [...(method.links ?? [])];
  for (const url of policy.evidenceUrls)
    if (!links.some((link) => link.url === url))
      links.push({ label: "Browser access evidence", url });
  return {
    ...method,
    instructions: method.instructions?.includes(policy.advice)
      ? method.instructions
      : method.instructions
        ? `${method.instructions}\n\n${policy.advice}`
        : policy.advice,
    links,
  };
}

/** A registered OAuth application's servers a page cannot read are carried by the bridge (ADR 0217). */
function withBridgeAdvice(
  providerId: string,
  method: NativeMethodDescriptor,
): NativeMethodDescriptor {
  if (method.id !== "oauth") return method;
  const advice = bridgeOAuthAdvice(providerId);
  if (!advice || method.instructions?.includes(advice.text)) return method;
  return {
    ...method,
    instructions: method.instructions
      ? `${method.instructions}\n\n${advice.text}`
      : advice.text,
    links: (method.links ?? []).some((link) => link.url === BRIDGE_README_URL)
      ? method.links
      : [
          ...(method.links ?? []),
          { label: "Connector bridge", url: BRIDGE_README_URL },
        ],
  };
}

export function nativePolicyMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  parameters: Readonly<Record<string, string>> = {},
): NativeMethodDescriptor {
  return withBridgeAdvice(
    providerId,
    policyMethod(providerId, method, parameters),
  );
}

function policyMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  parameters: Readonly<Record<string, string>>,
): NativeMethodDescriptor {
  if (method.unavailableKind === "policy") return method;
  const runtimeAvailable = method.runtimeAvailable ?? method.available;
  const policy = nativeConfigurationBrowserPolicy(
    providerId,
    method.id,
    parameters,
  );
  if (policy.available)
    return withAdvice(
      runtimeAvailable
        ? {
            ...method,
            runtimeAvailable,
            available: true,
            unavailableKind: undefined,
            unavailableReason: undefined,
          }
        : { ...method, runtimeAvailable, available: false },
      policy,
    );
  const reason =
    policy.reason ?? "This provider route is unavailable in this browser.";
  return {
    ...method,
    runtimeAvailable,
    available: false,
    configurable: runtimeAvailable || method.configurable === true,
    unavailableKind: "refuses-browser",
    unavailableReason: reason,
  };
}

export function nativeDraftMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  view: NativeConnectorView | null | undefined,
  values: NativeFieldValues,
  scopes?: Readonly<Record<string, readonly string[]>>,
): NativeMethodDescriptor {
  const configured =
    method.id === "mcp" &&
    ["bearer", "header", "anonymous"].includes(values.mcp_authentication ?? "");
  const current = configured
    ? { ...method, authorizeFirst: false, scopeGroups: [] }
    : method;
  return nativePolicyMethod(
    providerId,
    nativeMethodForEdit(current, view, values, scopes),
    nativeFieldValues(method.fields, values, false),
  );
}
