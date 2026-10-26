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

export type OidcTransport = "auto" | "native" | "browser";
export type OidcTokenAuthentication =
  | "auto"
  | "none"
  | "client_secret_basic"
  | "client_secret_post";
export type OidcEndpointOverrides = Readonly<{
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
}>;
export type OidcClientOptions = Readonly<{
  oidcAuthorizationEndpoint?: string;
  oidcTokenEndpoint?: string;
  jwksUri?: string;
  oidcTokenAuthentication?: OidcTokenAuthentication;
}>;
export function configuredOidcClientOptions(draft: OidcClientOptions) {
  return Object.freeze({
    endpoints: Object.freeze({
      authorizationEndpoint: draft.oidcAuthorizationEndpoint ?? "",
      tokenEndpoint: draft.oidcTokenEndpoint ?? "",
      jwksUri: draft.jwksUri ?? "",
    }),
    authentication: draft.oidcTokenAuthentication ?? "auto",
  });
}

export type ConfiguredOidc = Readonly<{
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  organization: OidcOrganization | null;
  endpoints?: OidcEndpointOverrides;
  authentication?: OidcTokenAuthentication;
}>;

export const OIDC_NATIVE_FIELDS = {
  oidcClientType: z.enum(["public", "confidential"]).default("public"),
  oidcTransport: z.enum(["auto", "native", "browser"]).default("auto"),
  oidcAuthorizationEndpoint: z.string().max(2048).default(""),
  oidcTokenEndpoint: z.string().max(2048).default(""),
  oidcTokenAuthentication: z
    .enum(["auto", "none", "client_secret_basic", "client_secret_post"])
    .default("auto"),
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
    oidcTransport?: OidcTransport;
    oidcAuthorizationEndpoint?: string;
    oidcTokenEndpoint?: string;
    oidcTokenAuthentication?: OidcTokenAuthentication;
  }>,
): boolean {
  return (
    draft.protocol === "oidc" &&
    Boolean(
      draft.oidcTransport === "native" ||
        draft.oidcTransport === "browser" ||
        draft.oidcAuthorizationEndpoint ||
        draft.oidcTokenEndpoint ||
        (draft.oidcTokenAuthentication &&
          draft.oidcTokenAuthentication !== "auto") ||
        draft.oidcClientType === "confidential" ||
        draft.clientSecret ||
        draft.organizationId,
    )
  );
}
/** Client protocol options do not imply a network route. Auto preserves confidential-client routing. */
export function usesNativeOidcTransport(
  draft: Readonly<{
    oidcTransport?: OidcTransport;
    oidcClientType?: "public" | "confidential";
    clientSecret: string;
  }>,
): boolean {
  if (draft.oidcTransport === "browser") return false;
  if (draft.oidcTransport === "native") return true;
  return draft.oidcClientType === "confidential" || Boolean(draft.clientSecret);
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
  const appOrigin = new URL(origin).origin;
  const root = new URL(base || "/", appOrigin);
  if (root.origin !== appOrigin || !base.startsWith("/"))
    throw new Error(
      "The OIDC callback base must be a path on this app origin.",
    );
  root.pathname = root.pathname.replace(/\/?$/, "/");
  return new URL("auth/native-connector.html", root).href;
}
export const NATIVE_OIDC_SETUP =
  "Register this app's callback URI with your identity provider. Use authorization code with S256 PKCE; confidential clients need an advertised client_secret_basic or client_secret_post method. Public clients use browser HTTPS when the provider permits CORS. Choose the Tailscale browser node for a configured native/private-CA route. Default routing retains that route for confidential clients; browser HTTPS can be selected explicitly. The saved secret stays write-only on this device. An organization binding must match the provider's signed ID-token claim. Save configuration, then sign in to verify your account; your original vault still uses its normal unlock.";
