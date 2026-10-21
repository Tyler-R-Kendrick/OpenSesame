/** Native confidential and organization OIDC uses the shared saved identity configuration. */
import { z } from "zod";
export type OidcOrganization = Readonly<{
  id: string;
  authorizationParameter: string;
  claim: string;
}>;
const reserved = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
  "response_mode",
  "prompt",
  "login_hint",
  "request",
  "request_uri",
  "resource",
  "claims",
  "authorization_details",
  "__proto__",
  "constructor",
  "prototype",
]);

export function assertOidcOrganization(value: OidcOrganization): void {
  if (
    !value.id ||
    value.id.length > 128 ||
    value.id.trim() !== value.id ||
    !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.authorizationParameter) ||
    reserved.has(value.authorizationParameter.toLowerCase()) ||
    !/^[A-Za-z_][A-Za-z0-9_.:/-]{0,127}$/.test(value.claim) ||
    reserved.has(value.claim.toLowerCase())
  )
    throw new Error("Invalid configured OIDC organization binding");
}

export const OIDC_NATIVE_FIELDS = {
  oidcClientType: z.enum(["public", "confidential"]).default("public"),
  oidcOrganizationParameter: z.string().max(64).default("organization"),
  oidcOrganizationClaim: z.string().max(128).default("org_id"),
};
type OrganizationFields = Readonly<{
  organizationId: string;
  oidcOrganizationParameter: string;
  oidcOrganizationClaim: string;
}>;
export function configuredOidcOrganization(
  draft: OrganizationFields,
): OidcOrganization | null {
  return draft.organizationId
    ? {
        id: draft.organizationId,
        authorizationParameter: draft.oidcOrganizationParameter,
        claim: draft.oidcOrganizationClaim,
      }
    : null;
}
export function isNativeOidcConfiguration(
  draft: Readonly<{
    protocol: string;
    clientSecret: string;
    oidcClientType?: "public" | "confidential";
    organizationId: string;
  }>,
): boolean {
  return (
    draft.protocol === "oidc" &&
    Boolean(
      draft.oidcClientType === "confidential" ||
        draft.clientSecret ||
        draft.organizationId,
    )
  );
}
export function nativeOidcConfigurationProblems(
  draft: OrganizationFields,
): string[] {
  const organization = configuredOidcOrganization(draft);
  try {
    if (organization) assertOidcOrganization(organization);
    return [];
  } catch {
    return [
      "Enter a valid OIDC organization ID, authorization parameter and signed claim",
    ];
  }
}
export function nativeOidcCallbackUri(origin: string, base: string): string {
  return new URL("auth/native-connector.html", new URL(base || "/", origin))
    .href;
}
export const NATIVE_OIDC_SETUP =
  "Register this app's native callback URI with your identity provider. Use authorization code with S256 PKCE; confidential clients need an advertised client_secret_basic or client_secret_post method. The saved secret stays write-only on this device. An organization binding must match the provider's signed ID-token claim. Save configuration, then sign in to verify your account; your original vault still uses its normal unlock.";
