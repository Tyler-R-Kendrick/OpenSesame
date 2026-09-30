/**
 * A hosted model request built from a connector saved on this device.
 * The model-provider record stays free of keys. The secret is attached
 * only to the request headers.
 */

import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import {
  type FeatureOperation,
  runListedFeature,
} from "./feature-connector-operation.js";
import {
  type FeatureRequest,
  featureRequest,
  savedFeatureRequests,
} from "./feature-request.js";

export type ModelExchange =
  | { ok: false; providerId: string }
  | {
      ok: true;
      providerId: string;
      operation: string;
      url: string;
      body: Record<string, string>;
      headers: Record<string, string>;
    };

export type DeliveredModel = {
  url: string;
  body: string;
  headers: Record<string, string>;
  providerId: string;
  operation: string;
};

const delivered: DeliveredModel[] = [];

function secretHeaders(secret: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (secret.credential) headers.authorization = secret.credential;
  for (const [name, value] of Object.entries(secret)) {
    if (name === "credential") continue;
    headers[`x-${name.replaceAll("_", "-")}`] = value;
  }
  return headers;
}

function modelUrl(provider: Provider, operation: string): string {
  const authority = provider.egress.authorities[0];
  const scheme = provider.egress.scheme === "http" ? "http" : "https";
  const path = `/${operation}`;
  return authority ? `${scheme}://${authority}${path}` : path;
}

function bodyHidesSecret(
  body: Record<string, string>,
  secret: Record<string, string>,
): boolean {
  const packed = JSON.stringify(body);
  return Object.values(secret).every(
    (value) => value === "" || !packed.includes(value),
  );
}

/** The inference request for one saved provider. Nothing saved does not succeed. */
export function modelExchange(provider: Provider | string): ModelExchange {
  const asked = typeof provider === "string" ? provider : provider.id;
  const row =
    typeof provider === "string" ? catalogProvider(provider) : provider;
  if (row && row.id !== asked) row.id = asked;
  const request: FeatureRequest = featureRequest(row ?? asked);
  if (!request.ok || !row) return { ok: false, providerId: asked };
  if (!bodyHidesSecret(request.fields, request.secret)) {
    return { ok: false, providerId: row.id };
  }
  return {
    ok: true,
    providerId: row.id,
    operation: request.operation,
    url: modelUrl(row, request.operation),
    body: request.fields,
    headers: secretHeaders(request.secret),
  };
}

export const hostedInferenceSeams = {
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init),
  deliver(exchange: ModelExchange & { ok: true }): DeliveredModel {
    const sent: DeliveredModel = {
      url: exchange.url,
      body: JSON.stringify(exchange.body),
      headers: { ...exchange.headers },
      providerId: exchange.providerId,
      operation: exchange.operation,
    };
    delivered.push(sent);
    void hostedInferenceSeams
      .fetch(sent.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...sent.headers,
        },
        body: sent.body,
        credentials: "omit",
      })
      .catch(() => undefined);
    return sent;
  },
};

export function deliveredModels(): readonly DeliveredModel[] {
  return delivered;
}

export function resetDeliveredModels(): void {
  delivered.length = 0;
}

function posted(exchange: ModelExchange & { ok: true }): ModelExchange {
  const sent = hostedInferenceSeams.deliver(exchange);
  const body = JSON.parse(sent.body) as Record<string, string>;
  return {
    ok: true,
    providerId: sent.providerId,
    operation: sent.operation,
    url: sent.url,
    body,
    headers: { ...sent.headers },
  };
}

/**
 * Post the operation `savedRemoteModel` returned. The key stays on the headers.
 * Nothing saved does not succeed.
 */
export function sendModelOperation(operation: FeatureOperation): ModelExchange {
  if (!operation.ok) return { ok: false, providerId: operation.providerId };
  const drafted = modelExchange(operation.providerId);
  if (!drafted.ok) return drafted;
  if (!bodyHidesSecret(operation.action, operation.secrets)) {
    return { ok: false, providerId: operation.providerId };
  }
  return posted({
    ok: true,
    providerId: operation.providerId,
    operation: operation.operation,
    url: drafted.url,
    body: { ...operation.action },
    headers: secretHeaders(operation.secrets),
  });
}

/** Send one saved provider's inference request. The key stays on that request. */
export function performInference(provider: Provider | string): ModelExchange {
  return sendModelOperation(runListedFeature(provider));
}

/** Every saved agent harness, not a single hardcoded provider. */
export function performSavedInferences(): ModelExchange[] {
  return savedFeatureRequests(["agent_harnesses"]).map((row) =>
    performInference(row.providerId),
  );
}
