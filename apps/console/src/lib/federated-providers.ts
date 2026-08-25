/**
 * The federated provider catalog the Identity API publishes (C8/D7).
 *
 * `GET /v1/federated/providers` is public and carries no issuers, endpoints or
 * secrets — only what a login surface needs to draw a button. Every failure
 * answers an empty list: the caller keeps its own fallback rather than
 * rendering a sign-in page with nothing on it.
 */

import {
  type BoundaryValue,
  isBoolean,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

export type FederatedProviderSummary = {
  id: string;
  label: string;
  kind: "oidc" | "oauth2";
  browserCapable: boolean;
};

function isSummary(value: BoundaryValue): value is FederatedProviderSummary {
  if (!isJsonObject(value)) return false;
  return (
    isString(value.id) &&
    value.id.length > 0 &&
    isString(value.label) &&
    (value.kind === "oidc" || value.kind === "oauth2") &&
    isBoolean(value.browserCapable)
  );
}

export async function listFederatedProviders(
  identityApi: string,
): Promise<FederatedProviderSummary[]> {
  const base = identityApi.replace(/\/$/, "");
  if (!base) return [];
  try {
    const res = await fetch(`${base}/v1/federated/providers`, {
      credentials: "omit",
    });
    if (!res.ok) return [];
    const body: { providers?: BoundaryValue } = overlapCast(await res.json());
    const providers = body.providers;
    if (!Array.isArray(providers)) return [];
    const summaries: FederatedProviderSummary[] = [];
    for (const entry of providers) {
      if (isSummary(entry)) summaries.push(entry);
    }
    return summaries;
  } catch {
    return [];
  }
}
