/**
 * Tailscale configuration saved on this device, attached to tailnet sync.
 * The auth key is a request header. It is not part of the public fields.
 * `tailnetSyncHeaders` loads the device record on that drive read or write.
 */

import {
  type FeatureOperation,
  runListedFeature,
} from "../feature-connector-operation.js";

let readTailnet = (): FeatureOperation => runListedFeature("tailscale");

/** The drive read calls this on every sync, after Networking is on. */
export function registerTailnetReader(
  reader: () => FeatureOperation,
): () => void {
  const previous = readTailnet;
  readTailnet = reader;
  return () => {
    if (readTailnet === reader) readTailnet = previous;
  };
}

export function currentTailnet(): FeatureOperation {
  return readTailnet();
}

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

/** Headers a drive read or write sends, including the saved tailnet configuration. */
export function tailnetSyncHeaders(
  base: Record<string, string> = {},
  saved = runListedFeature("tailscale"),
) {
  const headers = { ...base };
  if (!saved.ok) return headers;
  for (const [name, value] of Object.entries(saved.action)) {
    headers[`x-tailnet-${name.replaceAll("_", "-")}`] = value;
  }
  const authKey = saved.secrets.auth_key;
  if (authKey) headers["x-tailscale-auth-key"] = authKey;
  for (const [name, value] of Object.entries(saved.secrets)) {
    if (name === "auth_key") continue;
    headers[`x-tailscale-${name.replaceAll("_", "-")}`] = value;
  }
  return headers;
}

export function resetTailnetConnectorForTest(): void {
  bound = null;
  readTailnet = () => runListedFeature("tailscale");
}
