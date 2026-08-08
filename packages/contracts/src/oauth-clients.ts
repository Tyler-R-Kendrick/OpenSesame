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
  return scheme.includes(".") && !scheme.startsWith(".") && !scheme.endsWith(".");
}

export const RedirectUriSchema = z
  .string()
  .url()
  .refine(isAllowedRedirectUri, {
    message:
      "redirect_uri must be https, http on loopback, or a private-use scheme; no fragment or credentials",
  });

export const CreateOAuthClientRequestSchema = z.object({
  displayName: z.string().min(1).max(128),
  redirectUris: z.array(RedirectUriSchema).min(1),
  sectorIdentifier: z.string().min(1),
  grantTypes: z.array(z.string()).default(["authorization_code", "refresh_token"]),
  responseTypes: z.array(z.string()).default(["code"]),
  tokenEndpointAuthMethod: z.string().default("none"),
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
