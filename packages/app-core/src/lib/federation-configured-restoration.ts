/** Cold native sessions are checked at their saved provider without changing any vault or principal. */
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";
import {
  type VerifiedIdTokenClaims,
  decodeJwtEnvelope,
} from "@opensesame/sdk-browser";
import { configuredIdentitySessionTrusted } from "./federation-configured-token.js";
import type {
  RestorationResult,
  RestorationTrust,
} from "./federation-restoration.js";
import {
  clearFederationSessionJson,
  readFederationSessionJson,
  writeFederationSessionJson,
} from "./federation-session-store.js";
import {
  IdentitySessionUnavailableError,
  identitySessionAudience,
  identitySessionIssuer,
  verifyIdentitySessionAssertion,
} from "./identity-connections-session.js";
import {
  getIdentityConnectionRuntime,
  hydrateIdentityConnections,
} from "./identity-connections-store.js";

export async function restoreConfiguredIdentitySession(
  upstreamId: string,
  token: string,
  trust: RestorationTrust,
): Promise<RestorationResult | null> {
  if (!upstreamId.startsWith("identity:")) return null;
  try {
    await hydrateIdentityConnections();
  } catch {
    return { kind: "rejected", reason: "untrusted" };
  }
  const draft = getIdentityConnectionRuntime(
    upstreamId.slice("identity:".length),
  );
  if (!draft) return { kind: "rejected", reason: "untrusted" };
  if (draft.protocol !== "better-auth" && draft.protocol !== "supabase")
    return null;
  if (
    identitySessionIssuer(draft) !== trust.issuer ||
    identitySessionAudience(draft) !== trust.clientId
  )
    return { kind: "rejected", reason: "untrusted" };
  try {
    const identity = await verifyIdentitySessionAssertion(draft, token);
    identity.upstreamId = upstreamId;
    if (!configuredIdentitySessionTrusted(identity))
      return { kind: "rejected", reason: "untrusted" };
    const claims = decodeJwtEnvelope(token).claims;
    const verifiedClaims: VerifiedIdTokenClaims = {
      iss: identity.issuer,
      sub: identity.pairwiseSub,
      aud: identity.audience,
      exp: identity.expiresAt / 1000,
      iat: isNumber(claims.iat) ? claims.iat : 0,
    };
    if (identity.name) verifiedClaims.name = identity.name;
    if (identity.email) verifiedClaims.email = identity.email;
    return { kind: "authenticated", identity, claims: verifiedClaims };
  } catch (error) {
    if (error instanceof IdentitySessionUnavailableError)
      return {
        kind: "remembered",
        issuer: trust.issuer,
        audience: trust.clientId,
      };
    return { kind: "rejected", reason: "revoked" };
  }
}

/** Boot may call this before optional connectors hydrate; unconfigured applications make no request. */
export async function restoreConfiguredIdentityAtBoot(): Promise<void> {
  const raw = readFederationSessionJson();
  if (!raw) return;
  let stored: BoundaryValue;
  try {
    stored = JSON.parse(raw);
  } catch {
    return;
  }
  if (
    !isJsonObject(stored) ||
    !isString(stored.upstreamId) ||
    !isString(stored.idToken) ||
    !isString(stored.issuer) ||
    !isString(stored.audience) ||
    !isString(stored.jwksUri)
  )
    return;
  const result = await restoreConfiguredIdentitySession(
    stored.upstreamId,
    stored.idToken,
    {
      issuer: stored.issuer,
      clientId: stored.audience,
      jwksUri: stored.jwksUri,
    },
  );
  // A logout/account switch while the request was in flight always wins.
  if (readFederationSessionJson() !== raw || !result) return;
  if (result.kind === "authenticated")
    writeFederationSessionJson(JSON.stringify(result.identity));
  else if (result.kind === "rejected") clearFederationSessionJson();
}
