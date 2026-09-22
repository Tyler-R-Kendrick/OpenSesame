import { resolveResourceAlias } from "./aliases.js";
import { isCapabilityResourceKey } from "./capabilities-keys.js";
import { isForbiddenConfigPath } from "./forbidden.js";
import { PREFS_RESOURCE_KEY } from "./prefs-keys.js";

export type RegistryLookup =
  | { ok: true; resourceKey: string }
  | { ok: false; reason: "forbidden" | "unknown" };

/**
 * Only explicitly registered projections resolve. Guessing `config/*` or
 * walking into grants/key-wraps fails closed (ADV-01).
 */
export function lookupConfigResource(rawPath: string): RegistryLookup {
  if (isForbiddenConfigPath(rawPath)) {
    return { ok: false, reason: "forbidden" };
  }
  const key = resolveResourceAlias(rawPath);
  if (key === PREFS_RESOURCE_KEY) return { ok: true, resourceKey: key };
  if (key && isCapabilityResourceKey(key))
    return { ok: true, resourceKey: key };
  return { ok: false, reason: "unknown" };
}
