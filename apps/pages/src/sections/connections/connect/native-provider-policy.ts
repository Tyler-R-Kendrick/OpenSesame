/** Browser admission follows the central audited route, including public site and token choices. */
import {
  type NativeBrowserPolicyDecision,
  nativeBrowserMethodPolicy,
} from "@opensesame/app-core/lib/native-browser-policy.js";
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

export function nativePolicyMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  parameters: Readonly<Record<string, string>> = {},
): NativeMethodDescriptor {
  const policy = nativeBrowserMethodPolicy(providerId, method.id, parameters);
  if (policy.available) return withAdvice(method, policy);
  const reason =
    policy.reason ?? "This provider route is unavailable in this browser.";
  return {
    ...method,
    available: false,
    unavailableKind: "refuses-browser",
    unavailableReason: reason,
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
