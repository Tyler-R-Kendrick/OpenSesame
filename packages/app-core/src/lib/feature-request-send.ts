/**
 * Perform a saved connector operation. Public fields are the body. Secret
 * material is attached only on the request headers. Nothing saved does not
 * send, and a provider with no declared address is not sent to. Card data is
 * refused before any request.
 */

import {
  type JsonValue,
  assertNoPaymentCredentials,
} from "@opensesame/os-domain";
import type { Provider } from "./connections.js";
import { catalogProvider } from "./connector-catalog.js";
import { runListedFeature } from "./feature-connector-operation.js";
import {
  type FeatureRequest,
  savedFeatureRequests,
} from "./feature-request.js";

export const featureRequestSeams = {
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init),
  /**
   * Told of every operation a feature performed, whether or not its provider
   * has an address to send it to: what was performed is not the same thing as
   * what left the device.
   */
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

interface StringFields {
  [key: string]: string;
}

function secretHeaders(secret: StringFields): StringFields {
  const headers: StringFields = {};
  if (secret.credential) headers.authorization = secret.credential;
  for (const [name, value] of Object.entries(secret)) {
    if (name === "credential") continue;
    headers[`x-${name.replaceAll("_", "-")}`] = value;
  }
  return headers;
}

function bodyHidesSecret(body: StringFields, secret: StringFields): boolean {
  const packed = JSON.stringify(body);
  return Object.values(secret).every(
    (value) => value === "" || !packed.includes(value),
  );
}

/**
 * Where a saved operation goes: the first authority its provider declares, or
 * nowhere. A provider that declares none has no address to send to, and an
 * address made up for it would be a request that can only fail.
 */
function operationUrl(providerId: string, operation: string): string | null {
  const provider = catalogProvider(providerId);
  const authority = provider?.egress.authorities[0];
  if (!authority) return null;
  const scheme = provider?.egress.scheme === "http" ? "http" : "https";
  return `${scheme}://${authority}/${providerId}/${operation}`;
}

function refusesPayment(value: JsonValue): boolean {
  try {
    assertNoPaymentCredentials(value);
    return false;
  } catch {
    return true;
  }
}

/** Send one saved operation. The key stays on the headers. */
export function sendFeatureOperation(
  operation: ReturnType<typeof runListedFeature>,
): FeatureRequest {
  if (!operation.ok) return { ok: false, providerId: operation.providerId };
  const fields: StringFields = {};
  const secret: StringFields = {};
  for (const [name, value] of Object.entries(operation.action)) {
    fields[name] = value;
  }
  for (const [name, value] of Object.entries(operation.secrets)) {
    secret[name] = value;
  }
  if (refusesPayment({ ...fields, ...secret })) {
    return { ok: false, providerId: operation.providerId };
  }
  if (!bodyHidesSecret(fields, secret)) {
    return { ok: false, providerId: operation.providerId };
  }
  const url = operationUrl(operation.providerId, operation.operation);
  if (url !== null) {
    void featureRequestSeams
      .fetch(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...secretHeaders(secret),
        },
        body: JSON.stringify(fields),
        credentials: "omit",
      })
      .catch(() => undefined);
  }
  const request: FeatureRequest = {
    ok: true,
    providerId: operation.providerId,
    operation: operation.operation,
    fields,
    secret,
  };
  featureRequestSeams.performed(request);
  return request;
}

/** Read the device record and send that connector's operation. */
export function performSavedConnector(
  provider: Provider | string,
): FeatureRequest {
  return sendFeatureOperation(runListedFeature(provider));
}

function sendCategory(category: string): FeatureRequest[] {
  const send = categorySends.get(category);
  if (send) return send();
  const sent: FeatureRequest[] = [];
  for (const row of savedFeatureRequests([category])) {
    if (!row.ok) continue;
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
