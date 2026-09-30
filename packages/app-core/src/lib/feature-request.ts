/**
 * The request a Capabilities feature sends from a connector saved on this
 * device. Secret material stays on the request. Nothing saved does not succeed.
 */

import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { listDeviceConnections } from "./device-connectors.js";
import { runListedFeature } from "./feature-connector-operation.js";

export type FeatureRequest =
  | { ok: false; providerId: string }
  | {
      ok: true;
      providerId: string;
      operation: string;
      fields: Record<string, string>;
      secret: Record<string, string>;
    };

const armed = new Map<string, FeatureRequest & { ok: true }>();

export type DispatchedFeatureCall = {
  providerId: string;
  operation: string;
  fields: Record<string, string>;
  secret: Record<string, string>;
};

const dispatched: DispatchedFeatureCall[] = [];

/** Record the operation a feature will send. Secrets stay on that call. */
export function dispatchFeatureCall(request: FeatureRequest): FeatureRequest {
  if (!request.ok) return request;
  const call: DispatchedFeatureCall = {
    providerId: request.providerId,
    operation: request.operation,
    fields: { ...request.fields },
    secret: { ...request.secret },
  };
  dispatched.push(call);
  return {
    ok: true,
    providerId: call.providerId,
    operation: call.operation,
    fields: { ...call.fields },
    secret: { ...call.secret },
  };
}

/** The call a feature dispatched for one provider, if it performed the operation. */
export function dispatchedFeatureCall(
  providerId: string,
): DispatchedFeatureCall | undefined {
  for (let index = dispatched.length - 1; index >= 0; index -= 1) {
    const call = dispatched[index];
    if (call?.providerId === providerId) return call;
  }
  return undefined;
}

function idOf(provider: Provider | string): string {
  return typeof provider === "string" ? provider : provider.id;
}

/** Build the feature request from the saved device record, or refuse. */
export function featureRequest(provider: Provider | string): FeatureRequest {
  const run = runListedFeature(provider);
  if (!run.ok)
    return { ok: false, providerId: run.providerId || idOf(provider) };
  return {
    ok: true,
    providerId: run.providerId,
    operation: run.operation,
    fields: { ...run.action },
    secret: { ...run.secrets },
  };
}

/** Saved connectors in these catalog categories. The stored id is kept. */
export function savedFeatureRequests(
  categories: readonly string[],
): FeatureRequest[] {
  const wanted = new Set(categories);
  const requests: FeatureRequest[] = [];
  const seen = new Set<string>();
  for (const connection of listDeviceConnections()) {
    if (seen.has(connection.providerId)) continue;
    seen.add(connection.providerId);
    const provider = catalogProvider(connection.providerId);
    if (!provider || !wanted.has(provider.category)) continue;
    if (provider.id !== connection.providerId)
      provider.id = connection.providerId;
    const request = featureRequest(provider);
    if (request.ok) requests.push(request);
  }
  return requests;
}

/**
 * Hold the requests a feature will send. A later `currentUse` re-reads the
 * device record, so the secret attached is the one that was saved.
 */
export function rememberUses(
  uses: readonly FeatureRequest[],
): FeatureRequest[] {
  for (const use of uses) {
    if (!use.ok) {
      armed.delete(use.providerId);
      continue;
    }
    armed.set(use.providerId, {
      ok: true,
      providerId: use.providerId,
      operation: use.operation,
      fields: { ...use.fields },
      secret: { ...use.secret },
    });
  }
  return uses.filter((use) => use.ok).map((use) => currentUse(use.providerId));
}

/** The request the feature sends for one armed connector. */
export function currentUse(providerId: string): FeatureRequest {
  if (!armed.has(providerId)) return { ok: false, providerId };
  const fresh = featureRequest(providerId);
  if (!fresh.ok) {
    armed.delete(providerId);
    return fresh;
  }
  armed.set(providerId, fresh);
  return fresh;
}

export function resetFeatureUsesForTest(): void {
  armed.clear();
  dispatched.length = 0;
}
