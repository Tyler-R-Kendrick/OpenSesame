import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  SecretBackendError,
  type SecretBackendItem,
  type SecretBackendItemInput,
  type SecretBackendItemSummary,
} from "./types.js";

export function infisicalName(name: string): string {
  if (!/^[A-Za-z0-9_.-]{1,255}$/.test(name) || name === "." || name === "..")
    throw new SecretBackendError(
      "configuration",
      "Use a secret name containing letters, numbers, periods, underscores or dashes.",
    );
  return name;
}

export function infisicalSummary(
  value: BoundaryValue,
): SecretBackendItemSummary {
  if (!isJsonObject(value) || !isString(value.secretKey))
    throw new SecretBackendError(
      "response",
      "Infisical returned an unreadable secret record.",
    );
  return {
    id: infisicalName(value.secretKey),
    name: value.secretKey,
    kind: "secret",
  };
}

export function infisicalItem(body: BoundaryValue): SecretBackendItem {
  const value = isJsonObject(body) ? body.secret : undefined;
  if (
    !isJsonObject(value) ||
    !isString(value.secretValue) ||
    value.secretValueHidden === true
  )
    throw new SecretBackendError(
      "response",
      "Infisical did not return a readable secret value. Check the machine identity's permissions.",
    );
  const notes = isString(value.secretComment) ? value.secretComment : "";
  return { ...infisicalSummary(value), notes, secret: value.secretValue };
}

export function infisicalSummaries(
  body: BoundaryValue,
): SecretBackendItemSummary[] {
  if (!isJsonObject(body) || !Array.isArray(body.secrets))
    throw new SecretBackendError(
      "response",
      "Infisical returned an unreadable secret list.",
    );
  return body.secrets.map(infisicalSummary);
}

export function infisicalWritable(item: SecretBackendItemInput): void {
  infisicalName(item.name);
  if (item.username || item.url || Object.keys(item.fields ?? {}).length)
    throw new SecretBackendError(
      "unsupported",
      "Infisical stores a secret value and comment. Login fields need a backend that supports them.",
    );
}
