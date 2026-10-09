/** Browser admission follows the central audited route, including public site and token choices. */
import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import { nativeMethodForEdit } from "./native-connector-edit-values.js";
import { nativeFieldValues } from "./native-connector-ui-values.js";
import type {
  NativeFieldValues,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

export function nativePolicyMethod(
  providerId: string,
  method: NativeMethodDescriptor,
  parameters: Readonly<Record<string, string>> = {},
): NativeMethodDescriptor {
  const policy = nativeBrowserMethodPolicy(providerId, method.id, parameters);
  if (policy.available) return method;
  return {
    ...method,
    available: false,
    unavailableReason:
      policy.reason ?? "This provider route is unavailable in this browser.",
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
