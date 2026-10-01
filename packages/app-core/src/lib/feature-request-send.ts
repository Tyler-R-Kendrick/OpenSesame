/**
 * Perform a saved connector operation. Public fields are the body. Secret
 * material is attached only on the request headers. Nothing saved does not
 * send. Card data is refused before any request.
 */

import {
  type JsonValue,
  assertNoPaymentCredentials,
} from "@opensesame/os-domain";
import { catalogProvider } from "./connector-catalog.js";
import type { FeatureOperation } from "./feature-connector-operation.js";
import type { FeatureRequest } from "./feature-request.js";

export const featureRequestSeams = {
  fetch: (url: string, init: RequestInit): Promise<Response> =>
    globalThis.fetch(url, init),
};

function secretHeaders(secret: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (secret.credential) headers.authorization = secret.credential;
  for (const [name, value] of Object.entries(secret)) {
    if (name === "credential") continue;
    headers[`x-${name.replaceAll("_", "-")}`] = value;
  }
  return headers;
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
  operation: FeatureOperation,
): FeatureRequest {
  if (!operation.ok) return { ok: false, providerId: operation.providerId };
  const fields = { ...operation.action };
  const secret = { ...operation.secrets };
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
