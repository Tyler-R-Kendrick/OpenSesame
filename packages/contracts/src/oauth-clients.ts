import { z } from "zod";

export const ClientAdmissionModeSchema = z.enum([
  "pre_registered",
  "dynamic_registration",
  "client_metadata_document",
  "origin_profile",
]);

export const OAuthClientStateSchema = z.enum([
  "active",
  "suspended",
  "revoked",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * A redirect URI we are willing to send an authorization response to.
 *
 * `z.string().url()` alone accepts `javascript:`, `data:` and `file:` URLs — any
 * of which turns the authorization redirect into a script-execution or
 * exfiltration sink. Per RFC 6749 §3.1.2 / RFC 8252 §7 we accept https, http on
 * loopback (native apps in development), and private-use schemes that contain a
 * dot (`com.example.app:/cb`). Fragments and embedded credentials are rejected.
 */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  if (scheme === "https") return true;
  if (scheme === "http") return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  // Private-use scheme for native apps: must be a reverse-DNS style scheme.
  return (
    scheme.includes(".") && !scheme.startsWith(".") && !scheme.endsWith(".")
  );
}

export const RedirectUriSchema = z.string().url().refine(isAllowedRedirectUri, {
  message:
    "redirect_uri must be https, http on loopback, or a private-use scheme; no fragment or credentials",
});

/**
 * A sector identifier decides which pairwise subject a client sees, so it is not
 * a free-form label: two clients sharing one sector see the same `sub` for the
 * same person. Require the spec's form (an https URL, no query, fragment, or
 * credentials) so a sector is something a registrant can be held to.
 */
export function isAllowedSectorIdentifier(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.hash || url.search) return false;
  if (url.username || url.password) return false;
  return url.hostname.length > 0;
}

export const SectorIdentifierSchema = z
  .string()
  .refine(isAllowedSectorIdentifier, {
    message:
      "sectorIdentifier must be an https URL without query, fragment, or credentials",
  });

/**
 * Grant and response types this issuer will honour.
 *
 * These were free-form strings, so a registration could declare `implicit` or
 * `client_credentials` for itself — a token in a URL fragment with no PKCE, or a
 * client acting with no user at all. What the provider happens to have disabled
 * today is not a reason to let a record ask for it.
 */
export const GrantTypeSchema = z.enum([
  "authorization_code",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:device_code",
]);

export const ResponseTypeSchema = z.enum(["code"]);

export const TokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);

export const CreateOAuthClientRequestSchema = z.object({
  displayName: z.string().min(1).max(128),
  redirectUris: z.array(RedirectUriSchema).min(1),
  sectorIdentifier: SectorIdentifierSchema,
  grantTypes: z
    .array(GrantTypeSchema)
    .default(["authorization_code", "refresh_token"]),
  responseTypes: z.array(ResponseTypeSchema).default(["code"]),
  tokenEndpointAuthMethod: TokenEndpointAuthMethodSchema.default("none"),
  allowedScopes: z.array(z.string()).default(["openid"]),
  allowedResources: z.array(z.string()).default([]),
  admissionMode: ClientAdmissionModeSchema.default("pre_registered"),
});
export type CreateOAuthClientRequest = z.infer<
  typeof CreateOAuthClientRequestSchema
>;

export const PatchOAuthClientRequestSchema = z.object({
  displayName: z.string().min(1).max(128).optional(),
  redirectUris: z.array(RedirectUriSchema).min(1).optional(),
  allowedScopes: z.array(z.string()).optional(),
  allowedResources: z.array(z.string()).optional(),
  state: OAuthClientStateSchema.optional(),
});
export type PatchOAuthClientRequest = z.infer<
  typeof PatchOAuthClientRequestSchema
>;

export const OAuthClientResponseSchema = z.object({
  id: z.string(),
  ownerPrincipalId: z.string(),
  admissionMode: ClientAdmissionModeSchema,
  displayName: z.string(),
  redirectUris: z.array(z.string()),
  sectorIdentifier: z.string(),
  grantTypes: z.array(z.string()),
  responseTypes: z.array(z.string()),
  tokenEndpointAuthMethod: z.string(),
  allowedScopes: z.array(z.string()),
  allowedResources: z.array(z.string()),
  state: OAuthClientStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OAuthClientResponse = z.infer<typeof OAuthClientResponseSchema>;
