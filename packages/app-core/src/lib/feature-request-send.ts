/**
 * Legacy synchronous category routing. Registered native category callbacks
 * keep their own transports; unimplemented generic operations fail closed.
 * Provider drivers own awaited requests and verified results.
 */

import { isString } from "@opensesame/os-domain";
import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { listDeviceConnections } from "./device-connectors.js";
import type { FeatureOperation } from "./feature-connector-operation.js";
import type { FeatureRequest } from "./feature-request.js";

/** Compatibility observers; unsupported dispatch never invokes either hook. */
export const featureRequestSeams = {
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init),
  performed: (_request: FeatureRequest): void => undefined,
};

type CategorySend = () => FeatureRequest[];

const categorySends = new Map<string, CategorySend>();

/** Run this category's saved connectors when the feature performs the operation. */
export function registerCategorySend(
  category: string,
  send: CategorySend,
): () => void {
  categorySends.set(category, send);
  return () => {
    if (categorySends.get(category) === send) categorySends.delete(category);
  };
}

export function resetCategorySendsForTest(): void {
  categorySends.clear();
}

/** A saved descriptor is not an implemented provider operation. */
export function sendFeatureOperation(
  operation: FeatureOperation,
): FeatureRequest {
  return { ok: false, providerId: operation.providerId };
}

/** Provider operations must use their awaited native adapter. */
export function performSavedConnector(
  provider: Provider | string,
): FeatureRequest {
  return { ok: false, providerId: isString(provider) ? provider : provider.id };
}

function sendCategory(category: string): FeatureRequest[] {
  const send = categorySends.get(category);
  if (send) return send();
  const sent: FeatureRequest[] = [];
  const seen = new Set<string>();
  for (const row of listDeviceConnections()) {
    if (seen.has(row.providerId)) continue;
    seen.add(row.providerId);
    if (catalogProvider(row.providerId)?.category !== category) continue;
    sent.push(performSavedConnector(row.providerId));
  }
  return sent;
}

/** Send every saved connector in these categories. Nothing saved does not send. */
export function performSavedCategory(
  categories: readonly string[],
): FeatureRequest[] {
  const sent: FeatureRequest[] = [];
  const seen = new Set<CategorySend>();
  for (const category of categories) {
    const send = categorySends.get(category);
    if (send) {
      if (seen.has(send)) continue;
      seen.add(send);
      sent.push(...send());
      continue;
    }
    sent.push(...sendCategory(category));
  }
  return sent;
}
