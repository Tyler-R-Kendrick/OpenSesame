/**
 * What a capability feature did with the connector saved for it: the request
 * it sent, or the operation it performed where its provider declares no
 * address to send to (`feature-request-send.ts`). Shared by the saved-connector
 * walk (`capability-connector-use.test.tsx`).
 */

import type { Provider } from "@opensesame/app-core/lib/connections.js";
import type { FeatureRequest } from "@opensesame/app-core/lib/feature-request.js";
import { vi } from "vitest";
import {
  expectedPublic,
  expectedSecrets,
} from "./capability-connector-harness.js";

export type Used = {
  ok: boolean;
  fields: Record<string, string>;
  secret: Record<string, string>;
};

/** Every operation a feature performed, sent or not. */
export const performed: FeatureRequest[] = [];

export function missed(providerId: string): Used {
  return { ok: false, fields: {}, secret: {} };
}

export function headerRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

export function fetchBody(body: BodyInit | null | undefined): string {
  if (
    body == null ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof URLSearchParams ||
    body instanceof ReadableStream ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    return "";
  }
  return body;
}

/**
 * A provider that declares no address has nowhere to send its operation, so
 * nothing leaves the device (`feature-request-send.ts`): the operation is read
 * from what the feature performed instead, under the same checks.
 */
export function performedUse(provider: Provider): Used {
  if (provider.egress.authorities.length > 0) return missed(provider.id);
  const request = [...performed]
    .reverse()
    .find((row) => row.ok && row.providerId === provider.id);
  if (!request?.ok) return missed(provider.id);
  for (const [name, value] of Object.entries(expectedSecrets(provider))) {
    if (request.secret[name] !== value) return missed(provider.id);
    if (JSON.stringify(request.fields).includes(value))
      return missed(provider.id);
  }
  return { ok: true, fields: request.fields, secret: request.secret };
}

export function sentFetch(provider: Provider): Used {
  const call = [...vi.mocked(globalThis.fetch).mock.calls]
    .reverse()
    .find((row) => String(row[0]).includes(`/${provider.id}/`));
  if (!call) return performedUse(provider);
  const bodyText = fetchBody(call[1]?.body);
  try {
    // SAFETY: this json body is the string record the feature request posted.
    const fields = JSON.parse(bodyText) as Record<string, string>;
    const headers = headerRecord(call[1]?.headers);
    const secret: Record<string, string> = {};
    for (const [name, value] of Object.entries(expectedSecrets(provider))) {
      if (!Object.values(headers).includes(value)) return missed(provider.id);
      secret[name] = value;
    }
    for (const value of Object.values(secret)) {
      if (JSON.stringify(fields).includes(value)) return missed(provider.id);
    }
    return { ok: true, fields, secret };
  } catch {
    return missed(provider.id);
  }
}

/** The synchronous compatibility path cannot execute or prove a model response. */
export function sentModel(provider: Provider): Used {
  return missed(provider.id);
}

export function tailnetHeader(name: string, secret: boolean): string {
  const normalized = name.replaceAll("_", "-");
  if (secret && name === "auth_key") return "x-tailscale-auth-key";
  return secret ? `x-tailscale-${normalized}` : `x-tailnet-${normalized}`;
}

export function tailnetUsed(
  provider: Provider,
  headers: Record<string, string>,
): Used {
  const fields: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(expectedPublic(provider))) {
    if (headers[tailnetHeader(name, false)] !== value)
      return missed(provider.id);
    fields[name] = value;
  }
  for (const [name, value] of Object.entries(expectedSecrets(provider))) {
    if (headers[tailnetHeader(name, true)] !== value)
      return missed(provider.id);
    secret[name] = value;
  }
  return { ok: true, fields, secret };
}
