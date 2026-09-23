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
 * The OIDC `sector_identifier_uri` (Core §8.1): an https document on the
 * sector's own host listing every redirect URI. The URL shape says nothing
 * about who controls the sector, so it is only half the proof: Identity
 * fetches it and requires it to list every redirect URI before a client may
 * name a sector outside its redirect hosts.
 */
export const SectorIdentifierUriSchema = z
  .string()
  .max(2048)
  .refine(isAllowedSectorIdentifier, {
    message:
      "sectorIdentifierUri must be an https URL without query, fragment, or credentials",
  });

function webHostname(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.hostname || undefined;
}

/**
 * The redirect URIs that do not by themselves tie a client to its declared
 * sector: any whose host is neither the sector's host nor a subdomain of it
 * (loopback and private-use-scheme URIs included — they have no host a sector
 * could be proven by). A registration naming any of these must prove the
 * sector some other way (`sectorIdentifierUri`), or a verified principal could
 * hold another party's sector while receiving codes somewhere else.
 */
export function redirectUrisOutsideSector(
  sectorIdentifier: string,
  redirectUris: readonly string[],
): string[] {
  const sector = webHostname(sectorIdentifier);
  return redirectUris.filter((uri) => {
    const host = webHostname(uri);
    if (!sector || !host) return true;
    return host !== sector && !host.endsWith(`.${sector}`);
  });
}

/**
 * Operator release of a sector key (a squatted sector). The key is derived
 * from `sectorIdentifier` exactly as the issuer derives it; `reason` is kept in
 * the audit record.
 */
export const ReleaseSectorClaimRequestSchema = z
  .object({
    sectorIdentifier: z.string().trim().min(1).max(2048),
    reason: z.string().trim().min(1).max(512),
  })
  .strict();
export type ReleaseSectorClaimRequest = z.infer<
  typeof ReleaseSectorClaimRequestSchema
>;

/**
 * Grant and response types this issuer will honour.
 *
 * These were free-form strings, so a registration could declare `implicit`
 * for itself — a token in a URL fragment with no PKCE. `client_credentials`
 * is a confidential-client grant; Identity still refuses it on public clients.
 */
export const GrantTypeSchema = z.enum([
  "authorization_code",
  "refresh_token",
  "client_credentials",
  "urn:ietf:params:oauth:grant-type:device_code",
]);

export const ResponseTypeSchema = z.enum(["code"]);

export const TokenEndpointAuthMethodSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
  "private_key_jwt",
]);

const ClientJwksSchema = z
  .object({
    keys: z
      .array(
        z
          .object({
            kty: z.string().min(1),
            kid: z.string().min(1).optional(),
            use: z.string().optional(),
            alg: z.string().optional(),
            n: z.string().optional(),
            e: z.string().optional(),
            crv: z.string().optional(),
            x: z.string().optional(),
            y: z.string().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

export const CreateOAuthClientRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128),
    redirectUris: z.array(RedirectUriSchema).min(1),
    sectorIdentifier: SectorIdentifierSchema,
    sectorIdentifierUri: SectorIdentifierUriSchema.optional(),
    grantTypes: z
      .array(GrantTypeSchema)
      .default(["authorization_code", "refresh_token"]),
    responseTypes: z.array(ResponseTypeSchema).default(["code"]),
    tokenEndpointAuthMethod: TokenEndpointAuthMethodSchema.default("none"),
    allowedScopes: z.array(z.string()).default(["openid"]),
    allowedResources: z.array(z.string()).default([]),
    admissionMode: ClientAdmissionModeSchema.default("pre_registered"),
    jwks: ClientJwksSchema.optional(),
  })
  .strict();
export type CreateOAuthClientRequest = z.infer<
  typeof CreateOAuthClientRequestSchema
>;

export const PatchOAuthClientRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    redirectUris: z.array(RedirectUriSchema).min(1).optional(),
    sectorIdentifierUri: SectorIdentifierUriSchema.optional(),
    allowedScopes: z.array(z.string()).optional(),
    allowedResources: z.array(z.string()).optional(),
    grantTypes: z.array(GrantTypeSchema).min(1).optional(),
    tokenEndpointAuthMethod: TokenEndpointAuthMethodSchema.optional(),
    state: OAuthClientStateSchema.optional(),
    jwks: ClientJwksSchema.optional(),
  })
  .strict();
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
  jwks: ClientJwksSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OAuthClientResponse = z.infer<typeof OAuthClientResponseSchema>;
