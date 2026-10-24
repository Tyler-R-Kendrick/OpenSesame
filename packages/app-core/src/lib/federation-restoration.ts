/**
 * Authenticated restoration of a persisted federation session.
 *
 * Mutable JSON (expiresAt, name, verified flags) cannot independently
 * produce an authenticated principal. Restoration re-validates the signed
 * assertion against trusted configuration, or refuses.
 */

import { type JsonObject, isNumber, isString } from "@opensesame/os-domain";
import type { VerifiedIdTokenClaims } from "@opensesame/sdk-browser";
import { verifyRestoredBrowserIdToken } from "@opensesame/sdk-browser";
import { ambientAuthSeams } from "./ambient-auth-seam.js";
import { restoreConfiguredIdentityIfNative } from "./federation-configured-lazy.js";
import type { UpstreamIdentity } from "./federation-native-session.js";
import { parseStoredAssertion } from "./federation-stored-session.js";
export { readStoredSessionSync } from "./federation-stored-session.js";

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
      reason: "suppressed" | "untrusted" | "invalid" | "expired" | "revoked";
    };

function trustMatches(
  stored: JsonObject,
  trust: RestorationTrust | null,
): trust is RestorationTrust {
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
  if (ambientAuthSeams.autoAuthSuppressed())
    return { kind: "rejected", reason: "suppressed" };
  const stored = parseStoredAssertion(raw);
  if (!stored) return { kind: "rejected", reason: "invalid" };
  if (!trustMatches(stored, trust)) {
    return { kind: "rejected", reason: "untrusted" };
  }
  const native = await restoreConfiguredIdentityIfNative(stored, trust);
  if (native) return native;
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
