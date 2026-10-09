/** A verified binding can retain its sealed credential without revealing it. */
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import {
  nativeDefaults,
  nativeFieldValues,
  nativeVerified,
  nativeVisibleFields,
} from "./native-connector-ui-values.js";
import type {
  NativeConnectorDescriptor,
  NativeFieldValues,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

export function nativeInitialMethod(
  descriptor: NativeConnectorDescriptor,
  view?: NativeConnectorView | null,
) {
  if (view)
    return descriptor.methods.find(
      (method) => method.available && method.id === view.configuration.method,
    );
  for (const id of ["oidc", "oauth", "mcp", "api-key", "native-local"]) {
    const method = descriptor.methods.find(
      (entry) => entry.available && entry.id === id,
    );
    if (method) return method;
  }
  return undefined;
}

export function nativeEditTargetIds(
  method: NativeMethodDescriptor,
  view?: NativeConnectorView | null,
) {
  return ["api-key", "mcp"].includes(method.id)
    ? {}
    : (view?.configuration.targetIds ?? {});
}

export function nativeInitialValues(
  method: NativeMethodDescriptor,
  view?: NativeConnectorView | null,
) {
  const defaults = nativeDefaults(method.fields);
  if (view?.configuration.method !== method.id) return defaults;
  for (const field of method.fields) {
    if (
      !field.secret &&
      !field.readOnly &&
      view.configuration.parameters[field.id] !== undefined
    )
      defaults[field.id] = view.configuration.parameters[field.id];
    if (
      !field.secret &&
      field.id === "client_id" &&
      view.configuration.clientId
    )
      defaults[field.id] = view.configuration.clientId;
  }
  return Object.fromEntries(
    nativeVisibleFields(method.fields, defaults).map((field) => [
      field.id,
      defaults[field.id] ?? "",
    ]),
  );
}

function nativeMethodInstructions(
  method: NativeMethodDescriptor,
  values: NativeFieldValues,
): NativeMethodDescriptor {
  const selected = nativeVisibleFields(method.fields, values).find(
    (field) => field.secret && field.when && field.help,
  );
  return selected?.help ? { ...method, instructions: selected.help } : method;
}

export function nativeMethodForEdit(
  inputMethod: NativeMethodDescriptor,
  view: NativeConnectorView | null | undefined,
  values: NativeFieldValues,
): NativeMethodDescriptor {
  const method = nativeMethodInstructions(inputMethod, values);
  if (!view || !nativeVerified(view) || view.configuration.method !== method.id)
    return method;
  const saved = nativeFieldValues(
    method.fields,
    nativeInitialValues(method, view),
    false,
  );
  const current = nativeFieldValues(method.fields, values, false);
  if (
    Object.keys(saved).length !== Object.keys(current).length ||
    Object.entries(saved).some(
      ([id, value]) => value.trim() !== current[id]?.trim(),
    )
  )
    return method;
  return {
    ...method,
    fields: method.fields.map((field) =>
      field.secret
        ? {
            ...field,
            required: false,
            help: `${field.help ? `${field.help} ` : ""}Leave blank to keep the saved credential.`,
          }
        : field,
    ),
  };
}
