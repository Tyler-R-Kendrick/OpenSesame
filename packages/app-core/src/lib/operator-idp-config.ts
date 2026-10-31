/** The public configuration an unlock screen needs before sealed connectors hydrate. */
import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { samlEntityIdentifier } from "./identity-saml-config.js";
import { isLoopbackUrl } from "./urls.js";

export type OperatorIdp = {
  providerId: string;
  /** Exact SAML IdP entity ID, or the published OIDC discovery issuer. */
  issuer: string;
  /** Registered SAML SP entity ID, or the public OAuth client ID. */
  clientId: string;
  /** What the sign-in button calls it. */
  label: string;
  /** Saved identity adapter binding and requested OIDC scopes. */
  connectionId?: string;
  protocol?: "oidc" | "better-auth" | "supabase" | "saml";
  scope?: string;
  jwksUri?: string;
  providerHint?: string;
  /** Chooses a saved native OIDC dispatcher; never authenticates claims. */
  nativeIdentity?: true;
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

/** The marker cannot silently downgrade to a legacy/public dispatcher. */
function validNativeMarker(value: JsonObject): boolean {
  if (value.nativeIdentity === undefined) return true;
  return (
    value.nativeIdentity === true &&
    value.protocol === "oidc" &&
    isString(value.connectionId) &&
    value.connectionId.length > 0 &&
    value.connectionId.length <= 128 &&
    value.connectionId.trim() === value.connectionId
  );
}

export function readOperatorIdp(
  value: JsonValue | undefined,
): OperatorIdp | null {
  if (!isJsonObject(value)) return null;
  if (!validNativeMarker(value)) return null;
  if (value.protocol === "saml") return nativeSamlProvider(value);
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
  return operatorDetails(value, normalized);
}

function operatorDetails(
  value: JsonObject,
  normalized: OperatorIdp,
): OperatorIdp {
  if (value.nativeIdentity === true) normalized.nativeIdentity = true;
  if (isString(value.scope)) normalized.scope = value.scope;
  if (isString(value.jwksUri)) normalized.jwksUri = value.jwksUri;
  if (isString(value.providerHint))
    normalized.providerHint = value.providerHint;
  return normalized;
}

/** SAML entity identifiers are exact public trust, never OAuth issuer/discovery endpoints. */
function nativeSamlProvider(value: JsonObject): OperatorIdp | null {
  if (
    !isString(value.issuer) ||
    !isString(value.clientId) ||
    !samlEntityIdentifier(value.issuer) ||
    !samlEntityIdentifier(value.clientId)
  )
    return null;
  if (
    !isString(value.connectionId) ||
    !value.connectionId ||
    value.connectionId.length > 128 ||
    value.connectionId.trim() !== value.connectionId
  )
    return null;
  if (
    !isString(value.providerId) ||
    !value.providerId ||
    value.providerId.length > 128
  )
    return null;
  return {
    protocol: "saml",
    providerId: value.providerId,
    issuer: value.issuer,
    clientId: value.clientId,
    connectionId: value.connectionId,
    label:
      isString(value.label) && value.label.trim()
        ? value.label.trim()
        : "SAML identity",
  };
}
