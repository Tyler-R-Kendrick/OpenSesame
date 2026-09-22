/**
 * Authenticated restoration of a persisted federation session.
 *
 * Mutable JSON (expiresAt, name, verified flags) cannot independently
 * produce an authenticated principal. Restoration re-validates the signed
 * assertion against trusted configuration, or refuses.
 */

import {
  type BoundaryValue,
  type JsonObject,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import type { VerifiedIdTokenClaims } from "@opensesame/sdk-browser";
import {
  decodeJwtEnvelope,
  verifyRestoredBrowserIdToken,
} from "@opensesame/sdk-browser";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import type { UpstreamIdentity } from "./federation.js";

export type RestorationTrust = {
  issuer: string;
  clientId: string;
  jwksUri: string;
};

export type RestorationResult =
  | {
      kind: "authenticated";
      identity: UpstreamIdentity;
      claims: VerifiedIdTokenClaims;
    }
  | { kind: "remembered"; issuer: string; audience: string }
  | {
      kind: "rejected";
      reason: "suppressed" | "untrusted" | "invalid" | "expired";
    };

function parseStoredAssertion(raw: string): JsonObject | null {
  try {
    const stored: BoundaryValue = JSON.parse(raw);
    if (
      !isJsonObject(stored) ||
      !isString(stored.idToken) ||
      !isString(stored.issuer)
    ) {
      return null;
    }
    return stored;
  } catch {
    return null;
  }
}

function trustMatches(
  stored: JsonObject,
  trust: RestorationTrust | null,
): boolean {
  if (!trust || trim(trust.issuer) !== trim(String(stored.issuer)))
    return false;
  return isString(stored.audience) && stored.audience === trust.clientId;
}

export async function restoreAuthenticatedSession(
  raw: string | null,
  trust: RestorationTrust | null,
  fetchImpl: typeof fetch,
): Promise<RestorationResult> {
  if (!raw) return { kind: "rejected", reason: "invalid" };
  if (ambientAuthSeams.autoAuthSuppressed()) return { kind: "rejected", reason: "suppressed" };
  const stored = parseStoredAssertion(raw);
  if (!stored) return { kind: "rejected", reason: "invalid" };
  if (!trustMatches(stored, trust) || !trust) {
    return { kind: "rejected", reason: "untrusted" };
  }
  try {
    const claims = await verifyRestoredBrowserIdToken({
      token: String(stored.idToken),
      issuer: trust.issuer,
      clientId: trust.clientId,
      jwksUri: trust.jwksUri,
      fetchImpl,
    });
    if (claims.exp * 1000 <= Date.now()) {
      return { kind: "rejected", reason: "expired" };
    }
    const identity: UpstreamIdentity = {
      issuer: claims.iss,
      upstreamId: isString(stored.upstreamId) ? stored.upstreamId : "restored",
      idToken: String(stored.idToken),
      pairwiseSub: claims.sub,
      audience: trust.clientId,
      jwksUri: trust.jwksUri,
      expiresAt: claims.exp * 1000,
      ...(claims.email ? { email: claims.email } : undefined),
      ...(claims.name ? { name: claims.name } : undefined),
    };
    return { kind: "authenticated", identity, claims };
  } catch {
    if (isNumber(stored.expiresAt) && stored.expiresAt > Date.now()) {
      return {
        kind: "remembered",
        issuer: String(stored.issuer),
        audience: isString(stored.audience) ? stored.audience : "",
      };
    }
    return { kind: "rejected", reason: "invalid" };
  }
}

function trim(value: string): string {
  return value.replace(/\/+$/, "");
}

function looksLikeJwt(token: string): boolean {
  return token.split(".").length === 3;
}

function jwtAudience(aud: BoundaryValue): string | null {
  if (isString(aud)) return aud;
  if (Array.isArray(aud) && isString(aud[0])) return aud[0];
  return null;
}

function identityFromJwt(stored: JsonObject): UpstreamIdentity | null {
  if (!isString(stored.idToken) || !looksLikeJwt(stored.idToken)) return null;
  if (!isString(stored.upstreamId) || !isString(stored.jwksUri)) return null;
  try {
    const { claims } = decodeJwtEnvelope(stored.idToken);
    const audience = jwtAudience(claims.aud);
    const pairwiseSub = isString(claims.pairwise_sub)
      ? claims.pairwise_sub
      : isString(claims.sub)
        ? claims.sub
        : null;
    if (
      !isString(claims.iss) ||
      !pairwiseSub ||
      !isNumber(claims.exp) ||
      !audience
    ) {
      return null;
    }
    return {
      issuer: claims.iss,
      upstreamId: stored.upstreamId,
      idToken: stored.idToken,
      pairwiseSub,
      audience,
      jwksUri: stored.jwksUri,
      expiresAt: claims.exp * 1000,
      ...(isString(claims.email) ? { email: claims.email } : undefined),
      ...(isString(claims.name) ? { name: claims.name } : undefined),
      ...(isString(claims.picture) ? { picture: claims.picture } : undefined),
    };
  } catch {
    return null;
  }
}

function identityFromStoredJson(stored: JsonObject): UpstreamIdentity | null {
  if (
    !isString(stored.issuer) ||
    !isString(stored.upstreamId) ||
    !isString(stored.idToken) ||
    !isString(stored.pairwiseSub) ||
    !isString(stored.audience) ||
    !isString(stored.jwksUri) ||
    !isNumber(stored.expiresAt)
  ) {
    return null;
  }
  return {
    issuer: stored.issuer,
    upstreamId: stored.upstreamId,
    idToken: stored.idToken,
    pairwiseSub: stored.pairwiseSub,
    audience: stored.audience,
    jwksUri: stored.jwksUri,
    expiresAt: stored.expiresAt,
    ...(isString(stored.email) ? { email: stored.email } : undefined),
    ...(isString(stored.name) ? { name: stored.name } : undefined),
  };
}

/**
 * Synchronous restoration used by `loadSession`. JWT payload claims override
 * mutable JSON `expiresAt` / `name` / `sub`. Suppression wins. This is not a
 * signature check — `restoreAuthenticatedSession` does that online.
 */
export function readStoredSessionSync(
  raw: string | null,
  isTrustedIssuer: (issuer: string) => boolean,
): UpstreamIdentity | null {
  if (!raw) return null;
  if (ambientAuthSeams.autoAuthSuppressed()) return null;
  const stored = parseStoredAssertion(raw);
  if (!stored || !isString(stored.idToken)) return null;
  const identity = looksLikeJwt(stored.idToken)
    ? identityFromJwt(stored)
    : identityFromStoredJson(stored);
  if (!identity) return null;
  if (identity.expiresAt <= Date.now()) return null;
  if (!isTrustedIssuer(identity.issuer)) return null;
  return identity;
}
