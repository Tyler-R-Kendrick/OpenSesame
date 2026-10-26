/** Shared configuration for identity adapters; passwords used to sign in are never configuration. */
import { z } from "zod";
import { OIDC_NATIVE_FIELDS } from "./identity-oidc-config.js";
import { SAML_NATIVE_FIELDS } from "./identity-saml-config.js";
import { isLoopbackUrl } from "./urls.js";

export const IdentityProtocolSchema = z.enum([
  "oidc",
  "saml",
  "ldap",
  "better-auth",
  "supabase",
]);
export type IdentityProtocol = z.infer<typeof IdentityProtocolSchema>;
export const IdentityConnectionDraftSchema = z
  .object({
    providerId: z.string().min(1).max(128),
    name: z.string().max(128),
    protocol: IdentityProtocolSchema,
    issuer: z.string().max(2048),
    clientId: z.string().max(2048),
    audience: z.string().max(2048),
    jwksUri: z.string().max(2048),
    clientSecret: z.string().max(16384),
    ...OIDC_NATIVE_FIELDS,
    scope: z.string().max(2048),
    baseUrl: z.string().max(2048),
    publicKey: z.string().max(8192),
    brokerUrl: z.string().max(2048),
    organizationId: z.string().max(128),
    organizationSlug: z.string().max(128),
    samlMetadataUrl: z.string().max(2048),
    samlMetadataXml: z.string().max(262144),
    samlEntityId: z.string().max(2048),
    ...SAML_NATIVE_FIELDS,
    ldapUrl: z.string().max(2048),
    ldapBaseDn: z.string().max(2048),
    ldapBindDn: z.string().max(2048),
    ldapBindPassword: z.string().max(16384),
    ldapBindMode: z.enum(["bind_template", "search_then_bind"]),
    ldapBindTemplate: z.string().max(2048),
    ldapSearchFilter: z.string().max(2048),
    ldapSubjectAttribute: z.string().max(128),
    ldapEmailAttribute: z.string().max(128),
    ldapNameAttribute: z.string().max(128),
  })
  .strict();
export type IdentityConnectionDraft = z.infer<
  typeof IdentityConnectionDraftSchema
>;
export type IdentityConnectionCredentials = { email: string; password: string };
export type IdentityConnectionTest = { message: string };

/** An HTTPS endpoint, or explicit HTTP loopback for a local development provider. */
export function identityEndpoint(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.search || url.hash) return null;
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackUrl(url.href))
    )
      return null;
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function normalizeIdentityConnectionDraft(
  input: IdentityConnectionDraft,
): IdentityConnectionDraft {
  const draft = IdentityConnectionDraftSchema.parse(input);
  for (const field of [
    "name",
    "issuer",
    "clientId",
    "audience",
    "jwksUri",
    "scope",
    "baseUrl",
    "brokerUrl",
    "organizationId",
    "organizationSlug",
    "oidcAuthorizationEndpoint",
    "oidcTokenEndpoint",
    "oidcOrganizationParameter",
    "oidcOrganizationClaim",
    "samlMetadataUrl",
    "samlEntityId",
    "samlNameIdFormat",
    "samlAuthnContext",
    "ldapUrl",
    "ldapBaseDn",
    "ldapBindDn",
  ] as const) {
    draft[field] = draft[field].trim();
  }
  if (draft.protocol === "oidc" && draft.clientSecret)
    draft.oidcClientType = "confidential";
  for (const field of [
    "jwksUri",
    "baseUrl",
    "brokerUrl",
    "samlMetadataUrl",
  ] as const) {
    if (draft[field])
      draft[field] = identityEndpoint(draft[field]) ?? draft[field];
  }
  return draft;
}

export function identityConnectionUsesBroker(
  draft: IdentityConnectionDraft,
): boolean {
  return draft.protocol === "ldap";
}

export const IDENTITY_SECRET_FIELDS = [
  "clientSecret",
  "ldapBindPassword",
  "samlMetadataXml",
  "samlSigningPrivateKeyPkcs8",
] as const;
export function publicIdentityDraft(
  draft: IdentityConnectionDraft,
): IdentityConnectionDraft {
  return {
    ...draft,
    clientSecret: "",
    ldapBindPassword: "",
    samlMetadataXml: "",
    samlSigningPrivateKeyPkcs8: "",
  };
}
