/**
 * Tailscale configuration saved on this device, attached to tailnet sync.
 * The auth key is a request header. It is not part of the public fields.
 * Each drive read or write loads the device record again.
 */

import { runListedFeature } from "../feature-connector-operation.js";

export type BoundTailnet = {
  providerId: string;
  operation: string;
  fields: Record<string, string>;
  secret: Record<string, string>;
};

let bound: BoundTailnet | null = null;

export function bindTailnetConnector(next: BoundTailnet | null): void {
  bound = next
    ? {
        providerId: next.providerId,
        operation: next.operation,
        fields: { ...next.fields },
        secret: { ...next.secret },
      }
    : null;
}

export function boundTailnet(): BoundTailnet | null {
  return bound
    ? {
        providerId: bound.providerId,
        operation: bound.operation,
        fields: { ...bound.fields },
        secret: { ...bound.secret },
      }
    : null;
}

function refreshTailnet(): void {
  const live = runListedFeature("tailscale");
  if (!live.ok) {
    bound = null;
    return;
  }
  bound = {
    providerId: live.providerId,
    operation: live.operation,
    fields: { ...live.action },
    secret: { ...live.secrets },
  };
}

/** Headers a drive read or write sends, including the saved tailnet configuration. */
export function tailnetSyncHeaders(base: Record<string, string> = {}) {
  refreshTailnet();
  const headers = { ...base };
  if (!bound) return headers;
  for (const [name, value] of Object.entries(bound.fields)) {
    headers[`x-tailnet-${name.replaceAll("_", "-")}`] = value;
  }
  if (bound.secret.auth_key)
    headers["x-tailscale-auth-key"] = bound.secret.auth_key;
  for (const [name, value] of Object.entries(bound.secret)) {
    if (name === "auth_key") continue;
    headers[`x-tailscale-${name.replaceAll("_", "-")}`] = value;
  }
  return headers;
}

export function resetTailnetConnectorForTest(): void {
  bound = null;
}
