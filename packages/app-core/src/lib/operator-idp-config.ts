/** The public configuration an unlock screen needs before sealed connectors hydrate. */
import { type JsonValue, isJsonObject, isString } from "@opensesame/os-domain";
import { isLoopbackUrl } from "./urls.js";

export type OperatorIdp = {
  providerId: string;
  /** The OIDC issuer, as published in its discovery document. */
  issuer: string;
  /** The public client id the operator registered for this origin. */
  clientId: string;
  /** What the sign-in button calls it. */
  label: string;
  /** Saved identity adapter binding and requested OIDC scopes. */
  connectionId?: string;
  protocol?: "oidc" | "better-auth" | "supabase";
  scope?: string;
  jwksUri?: string;
  providerHint?: string;
};

/**
 * A provider is admitted only whole: an absolute https issuer (or loopback
 * http, for a local IdP) and a non-empty client id. A half-written record
 * would otherwise become a trusted issuer with nothing behind it — see
 * `isOperatorIdpIssuer` in `federation.ts`, which reads this.
 */
export function normalizeOperatorIdp(
  providerId: string,
  issuer: string,
  clientId: string,
  label?: string,
): OperatorIdp | null {
  const trimmedIssuer = issuer.trim().replace(/\/+$/, "");
  const trimmedClientId = clientId.trim();
  if (!trimmedIssuer || !trimmedClientId) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmedIssuer);
  } catch {
    return null;
  }
  // https, or loopback http for a local IdP. Anything else would send an
  // authorization code over the wire in the clear.
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopbackUrl(trimmedIssuer)))
  ) {
    return null;
  }
  return {
    providerId: providerId.trim(),
    issuer: trimmedIssuer,
    clientId: trimmedClientId,
    label: label?.trim() || parsed.hostname,
  };
}

export function readOperatorIdp(
  value: JsonValue | undefined,
): OperatorIdp | null {
  if (!isJsonObject(value)) return null;
  const { providerId, issuer, clientId, label } = value;
  if (!isString(issuer) || !isString(clientId)) return null;
  const normalized = normalizeOperatorIdp(
    isString(providerId) ? providerId : "",
    issuer,
    clientId,
    isString(label) ? label : undefined,
  );
  if (!normalized) return null;
  if (isString(value.connectionId)) {
    normalized.connectionId = value.connectionId;
    normalized.issuer = issuer.trim();
  }
  if (
    value.protocol === "oidc" ||
    value.protocol === "better-auth" ||
    value.protocol === "supabase"
  )
    normalized.protocol = value.protocol;
  if (isString(value.scope)) normalized.scope = value.scope;
  if (isString(value.jwksUri)) normalized.jwksUri = value.jwksUri;
  if (isString(value.providerHint))
    normalized.providerHint = value.providerHint;
  return normalized;
}
