import { nativeBrowserMethodPolicy } from "@opensesame/app-core/lib/native-browser-policy.js";
import type { NativeConnectorView } from "@opensesame/app-core/lib/native-connector-view.js";
import type {
  NativeField,
  NativeFieldValues,
  NativeMethodDescriptor,
} from "./native-connector-ui.js";

export function nativeDefaults(fields: readonly NativeField[]) {
  const selectors = Object.fromEntries(
    fields
      .filter((field) => !field.when && !field.secret)
      .map((field) => [field.id, field.defaultValue ?? ""]),
  );
  return Object.fromEntries(
    nativeVisibleFields(fields, selectors).map((field) => [
      field.id,
      field.secret ? "" : (field.defaultValue ?? ""),
    ]),
  );
}

export function nativeVisibleFields(
  fields: readonly NativeField[],
  values: NativeFieldValues,
) {
  return fields.filter(
    (field) => !field.when || values[field.when.fieldId] === field.when.value,
  );
}

export function nativeNextValues(
  fields: readonly NativeField[],
  values: NativeFieldValues,
  id: string,
  value: string,
) {
  const next = { ...values, [id]: value };
  if (!fields.some((field) => field.when?.fieldId === id)) return next;
  const previous = new Set(nativeVisibleFields(fields, values));
  return Object.fromEntries(
    nativeVisibleFields(fields, next).map((field) => [
      field.id,
      field.secret
        ? ""
        : previous.has(field)
          ? (next[field.id] ?? "")
          : (field.defaultValue ?? ""),
    ]),
  );
}

export function nativeScopeDefaults(
  method: NativeMethodDescriptor,
  selected?: Record<string, string[]>,
) {
  return Object.fromEntries(
    method.scopeGroups.map((group) => {
      const defaults = group.choices
        .filter((choice) => choice.default)
        .map((choice) => choice.name);
      const scopes = [
        ...new Set([
          ...(selected?.[group.actor] ?? defaults),
          ...(group.requiredScopes ?? []),
        ]),
      ].filter((scope) =>
        group.choices.some((choice) => choice.name === scope),
      );
      return [group.actor, scopes];
    }),
  );
}

export function nativeFieldValues(
  fields: readonly NativeField[],
  values: NativeFieldValues,
  secret: boolean,
) {
  return Object.fromEntries(
    nativeVisibleFields(fields, values)
      .filter((field) => field.secret === secret && !field.displayOnly)
      .map((field) => [field.id, values[field.id] ?? ""]),
  );
}

export function nativeMissingField(
  fields: readonly NativeField[],
  values: NativeFieldValues,
) {
  return nativeVisibleFields(fields, values).find(
    (field) => field.required && !values[field.id]?.trim(),
  );
}

export function nativeError(
  message: string,
  credentials: Record<string, string>,
) {
  let sanitized = message;
  for (const value of Object.values(credentials)) {
    if (value) sanitized = sanitized.replaceAll(value, "[credential removed]");
  }
  return sanitized;
}

export function nativeVerified(view: NativeConnectorView): boolean {
  return (
    view.status === "connected" &&
    view.verifiedAt !== null &&
    nativeBrowserMethodPolicy(
      view.providerId,
      view.configuration.method,
      view.configuration.parameters,
    ).available
  );
}

export function nativePublicUrl(value: string, origins?: readonly string[]) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (origins && !origins.includes(url.origin)) return null;
    return url.href;
  } catch {
    return null;
  }
}
