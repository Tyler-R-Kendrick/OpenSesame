/**
 * The operation a Capabilities feature runs from a connector saved on this
 * device. Non-secret fields are the request. Secret material is attached
 * only on the operation.
 */

import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { runFeatureConnector } from "./device-connectors.js";

export type FeatureOperation =
  | { ok: false; providerId: string }
  | {
      ok: true;
      providerId: string;
      operation: string;
      /** Non-secret fields on the request or local action. */
      action: Record<string, string>;
      /** Secret material attached only to this operation. */
      secrets: Record<string, string>;
    };

function providerOf(provider: Provider | string): Provider | null {
  if (typeof provider !== "string") return provider;
  const row = catalogProvider(provider);
  if (!row) return null;
  // The page stores the id it listed. An alias such as `aws-parameter-store`
  // must not be rewritten to the catalog row id before the device lookup.
  if (row.id !== provider) row.id = provider;
  return row;
}

/** Build the feature operation for one saved connector, or refuse when none is saved. */
export function runListedFeature(
  provider: Provider | string,
): FeatureOperation {
  const row = providerOf(provider);
  const providerId = typeof provider === "string" ? provider : provider.id;
  if (!row) return { ok: false, providerId };
  const run = runFeatureConnector(row);
  if (!run.ok) return { ok: false, providerId: row.id };
  return {
    ok: true,
    providerId: row.id,
    operation: run.operation,
    action: { ...run.fields },
    secrets: { ...run.secrets },
  };
}
