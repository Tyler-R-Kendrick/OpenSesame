/**
 * Run the saved connector operation for the categories a feature owns.
 * The connection list is the device record; secrets stay inside the operation.
 */

import type { Provider } from "@opensesame/app-core/lib/connections.js";
import { catalogProvider } from "@opensesame/app-core/lib/connector-catalog.js";
import { listDeviceConnections } from "@opensesame/app-core/lib/device-connectors.js";
import type { FeatureOperation } from "@opensesame/app-core/lib/feature-connector-operation.js";

export function applySavedConnectors(
  categories: readonly string[],
  run: (provider: Provider) => FeatureOperation,
): FeatureOperation[] {
  const wanted = new Set(categories);
  const applied: FeatureOperation[] = [];
  for (const row of listDeviceConnections()) {
    const provider = catalogProvider(row.providerId);
    if (!provider || !wanted.has(provider.category)) continue;
    const operation = run(provider);
    if (operation.ok) applied.push(operation);
  }
  return applied;
}
