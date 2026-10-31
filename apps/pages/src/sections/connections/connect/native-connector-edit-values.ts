/** A verified binding can retain its sealed credential without revealing it. */
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import {
  nativeDefaults,
  nativeFieldValues,
  nativeVerified,
  nativeVisibleFields,
} from "./native-connector-ui-values.js";
import { nativeMethodConfigurable } from "./native-connector-ui.js";
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
      (method) =>
        nativeMethodConfigurable(method) &&
        method.id === view.configuration.method,
    );
  const configurable = descriptor.methods.filter(nativeMethodConfigurable);
  // A policy-refused route stays configurable so an operator can prepare it,
  // but a new connection must not open on a form whose Connect button is
  // disabled when a usable route exists.
  const usable = configurable.filter((method) => method.available);
  const available = usable.length ? usable : configurable;
  const ranked = available
    .filter((method) => method.preferredRank !== undefined)
    .sort(
      (left, right) =>
        (left.preferredRank ?? Number.MAX_SAFE_INTEGER) -
        (right.preferredRank ?? Number.MAX_SAFE_INTEGER),
    );
  if (ranked[0]) return ranked[0];
  for (const id of ["oidc", "oauth", "mcp", "api-key", "native-local"]) {
    const method = available.find((entry) => entry.id === id);
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
    // A connection saved before a provider's own OAuth stopped sending the
    // RFC 8707 `resource` did send it: reopening it must not silently change it.
    if (
      field.id === "resource_parameter" &&
      view.configuration.parameters.resource_parameter === undefined
    )
      defaults[field.id] = "send";
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
  scopes?: Readonly<Record<string, readonly string[]>>,
): NativeMethodDescriptor {
  const method = nativeMethodInstructions(inputMethod, values);
  if (!view || !nativeVerified(view) || view.configuration.method !== method.id)
    return method;
  if (
    method.id === "oauth" &&
    scopes &&
    JSON.stringify(scopes) !==
      JSON.stringify(view.configuration.requestedScopes)
  )
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
