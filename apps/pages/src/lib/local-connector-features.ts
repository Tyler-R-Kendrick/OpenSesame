/**
 * Password-manager and local-storage connectors have no optional module.
 * Their feature operation is the saved device configuration.
 */

import type { Provider } from "@opensesame/app-core/lib/connections.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "@opensesame/app-core/lib/feature-connector-operation.js";

export function savedPasswordManagerOperation(
  provider: Provider | string,
): FeatureOperation {
  return runListedFeature(provider);
}

export function savedLocalStorageOperation(
  provider: Provider | string,
): FeatureOperation {
  return runListedFeature(provider);
}
