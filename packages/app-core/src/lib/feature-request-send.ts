/**
 * Perform a saved connector operation. Public fields are the body. Secret
 * material is attached only on the request headers. Nothing saved does not
 * send. Card data is refused before any request.
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
};

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

function operationUrl(providerId: string, operation: string): string {
  const provider = catalogProvider(providerId);
  const authority = provider?.egress.authorities[0];
  const scheme = provider?.egress.scheme === "http" ? "http" : "https";
  const path = `/${providerId}/${operation}`;
  return authority
    ? `${scheme}://${authority}${path}`
    : `https://connectors.invalid${path}`;
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
  const headers = secretHeaders(secret);
  void featureRequestSeams
    .fetch(operationUrl(operation.providerId, operation.operation), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(fields),
      credentials: "omit",
    })
    .catch(() => undefined);
  return {
    ok: true,
    providerId: operation.providerId,
    operation: operation.operation,
    fields,
    secret,
  };
}

/** Read the device record and send that connector's operation. */
export function performSavedConnector(
  provider: Provider | string,
): FeatureRequest {
  return sendFeatureOperation(runListedFeature(provider));
}

/** Send every saved connector in these categories. Nothing saved does not send. */
export function performSavedCategory(
  categories: readonly string[],
): FeatureRequest[] {
  const sent: FeatureRequest[] = [];
  for (const row of savedFeatureRequests(categories)) {
    if (!row.ok) continue;
    sent.push(performSavedConnector(row.providerId));
  }
  return sent;
}
