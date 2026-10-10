/** Cleanup derives tenant endpoints from the immutable grant, never from a changed form. */
import type { NativeGrant } from "./native-connector-schema.js";
import { NativeOAuthError } from "./native-oauth-errors.js";
import { nativeTenantOAuthEndpoints } from "./native-tenant-oauth.js";
export function approvedNativeOAuthRevocationEndpoint(
  grant: NativeGrant,
): string | null {
  if (grant.providerId !== "auth0" && grant.providerId !== "okta") return null;
  if (!grant.issuer) throw new NativeOAuthError("cleanup");
  const issuer = new URL(grant.issuer);
  const endpoints = nativeTenantOAuthEndpoints(
    grant.providerId,
    issuer.hostname,
  );
  if (
    grant.issuer !== endpoints.issuer ||
    grant.endpoint !== endpoints.token ||
    !grant.clientId
  )
    throw new NativeOAuthError("cleanup");
  return endpoints.revocation;
}
