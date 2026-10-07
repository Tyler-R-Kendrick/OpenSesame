/** Quarantined pre-principal device records: never an authentication source. */
import { z } from "zod";
import { kvGet } from "./kv.js";
export const LEGACY_CONNECTOR_PUBLIC_KEY = "opensesame.device-connectors.v1";
export const LEGACY_CONNECTOR_SECRET_KEY =
  "opensesame.device-connector-secrets.v1";
const fields = z.record(z.string().max(256), z.string().max(32768));
export const legacyConnectorRowSchema = z
  .object({
    connectionId: z.string().min(1).max(256),
    providerId: z.string().min(1).max(256),
    displayName: z.string().max(1024),
    scopes: z.array(z.string().max(256)).max(64),
    fields,
    createdAt: z.string().max(64),
    updatedAt: z.string().max(64),
    owner: z.string().max(512).optional(),
    secretItemId: z.string().max(256).optional(),
  })
  .strict();
export const legacyConnectorSecretsSchema = z
  .record(z.string().min(1).max(256), fields)
  .refine((value) => Object.keys(value).length <= 256);
export function hasUnresolvedLegacyConnectorSecrets(): boolean {
  const raw = kvGet(LEGACY_CONNECTOR_SECRET_KEY);
  if (!raw) return false;
  try {
    const map = legacyConnectorSecretsSchema.parse(JSON.parse(raw));
    return Object.values(map).some((entry) => Object.keys(entry).length > 0);
  } catch {
    return true;
  }
}
