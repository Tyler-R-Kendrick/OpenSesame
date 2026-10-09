/**
 * Perform a saved connector operation. Public fields are the body. Short-lived
 * bearer material may ride on request headers; PEMs, SSH keys and other
 * multi-line secrets never do. Nothing saved does not send, and a provider
 * with no declared address is not sent to. Card data is refused before any
 * request. Header values are screened before send. PEM-class secrets skip the
 * network call entirely; short-lived bearer tokens still ride on headers when safe.
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

/** Git backup and app credentials that must never be copied into HTTP headers. */
const SECRETS_NEVER_IN_HEADERS = new Set([
  "private_key_pem",
  "ssh_private_key",
  "ssh_passphrase",
]);

function headerSafeSecretValue(value: string): boolean {
  return value !== "" && !/[\r\n\0]/.test(value);
}

function secretsMayLeaveInHeaders(secret: StringFields): boolean {
  for (const [name, value] of Object.entries(secret)) {
    if (SECRETS_NEVER_IN_HEADERS.has(name)) return false;
    if (!headerSafeSecretValue(value)) return false;
  }
  return true;
}

function secretHeaders(secret: StringFields): StringFields {
  const headers: StringFields = {};
  if (secret.credential && headerSafeSecretValue(secret.credential)) {
    headers.authorization = secret.credential;
  }
  for (const [name, value] of Object.entries(secret)) {
    if (name === "credential") continue;
    if (SECRETS_NEVER_IN_HEADERS.has(name)) continue;
    if (!headerSafeSecretValue(value)) continue;
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

/** Send one saved operation when its secrets may ride on the headers. */
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
  if (url !== null && secretsMayLeaveInHeaders(secret)) {
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
