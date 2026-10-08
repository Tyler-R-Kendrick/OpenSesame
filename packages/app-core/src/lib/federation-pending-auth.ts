/**
 * PKCE pending record shape validation (split from federation-pending for complexity ratchet).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
  overlapCast,
} from "@opensesame/os-domain";

const MIN_VERIFIER_LEN = 43;
const MIN_STATE_LEN = 8;

export type PendingAuth = {
  upstreamId: string;
  issuer: string;
  verifier: string;
  state: string;
  tokenEndpoint: string;
  jwksUri: string;
  scope: string;
  createdAt?: number;
  sessionCheckEndpoint?: string | undefined;
  redirectUri?: string;
  clientId?: string;
  returnTo?: string | undefined;
  orgSlug?: string | undefined;
  orgMethod?: "sso" | "saml" | undefined;
};

function readRequiredStrings(raw: Record<string, BoundaryValue>): {
  upstreamId: string;
  issuer: string;
  verifier: string;
  state: string;
  tokenEndpoint: string;
  jwksUri: string;
  scope: string;
  createdAt: number;
} | null {
  if (
    !isString(raw.upstreamId) ||
    !isString(raw.issuer) ||
    !isString(raw.verifier) ||
    raw.verifier.length < MIN_VERIFIER_LEN ||
    !isString(raw.state) ||
    raw.state.length < MIN_STATE_LEN ||
    !isString(raw.tokenEndpoint) ||
    !isString(raw.jwksUri) ||
    !isString(raw.scope) ||
    !isNumber(raw.createdAt)
  ) {
    return null;
  }
  return {
    upstreamId: raw.upstreamId,
    issuer: raw.issuer,
    verifier: raw.verifier,
    state: raw.state,
    tokenEndpoint: raw.tokenEndpoint,
    jwksUri: raw.jwksUri,
    scope: raw.scope,
    createdAt: raw.createdAt,
  };
}

function applyOptionalPendingFields(
  pending: PendingAuth,
  raw: Record<string, BoundaryValue>,
): void {
  if (isString(raw.sessionCheckEndpoint)) {
    pending.sessionCheckEndpoint = raw.sessionCheckEndpoint;
  }
  if (isString(raw.redirectUri)) {
    pending.redirectUri = raw.redirectUri;
  }
  if (isString(raw.clientId)) {
    pending.clientId = raw.clientId;
  }
  if (isString(raw.returnTo)) {
    pending.returnTo = raw.returnTo;
  }
  if (isString(raw.orgSlug)) {
    pending.orgSlug = raw.orgSlug;
  }
  if (raw.orgMethod === "sso" || raw.orgMethod === "saml") {
    pending.orgMethod = raw.orgMethod;
  }
}

export function asPendingAuth(value: BoundaryValue): PendingAuth | null {
  const raw = overlapCast(value);
  if (!isJsonObject(raw)) return null;
  const required = readRequiredStrings(raw);
  if (!required) return null;
  const pending: PendingAuth = { ...required };
  applyOptionalPendingFields(pending, raw);
  return pending;
}
