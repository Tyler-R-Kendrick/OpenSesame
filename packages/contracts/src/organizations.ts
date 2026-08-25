import { z } from "zod";

export const OrganizationStateSchema = z.enum([
  "provisional",
  "active",
  "suspended",
  "deleted",
]);

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const OrganizationAuthMethodKindSchema = z.enum(["sso", "saml", "ldap"]);
export type OrganizationAuthMethodKind = z.infer<
  typeof OrganizationAuthMethodKindSchema
>;

/** Org IdP / SAML-broker issuer. http is allowed so local mock IdP and Keycloak work. */
export const OrganizationIssuerUrlSchema = z
  .string()
  .min(8)
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "issuer must be an http(s) URL");

export const CreateOrganizationRequestSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1).max(128),
  ssoIssuer: OrganizationIssuerUrlSchema.optional(),
  samlIssuer: OrganizationIssuerUrlSchema.optional(),
});
export type CreateOrganizationRequest = z.infer<
  typeof CreateOrganizationRequestSchema
>;

/**
 * The client id a tenant's own IdP issued for this deployment.
 *
 * Opaque to us — Entra issues a GUID, Okta a 20-character string, Google a
 * `...apps.googleusercontent.com` hostname — so this bounds the length and
 * refuses control characters rather than imposing a shape none of them share.
 */
export const OrganizationClientIdSchema = z
  .string()
  .min(1)
  .max(256)
  // Bounded and printable rather than shaped: a control character or a space
  // spliced into a client id would reach the authorize URL's query string,
  // and no two providers agree on a shape to validate against.
  .refine(
    (value) => ![...value].some((ch) => ch <= " " || ch === "\u007f"),
    "must not contain whitespace or control characters",
  );

/** The secret issued alongside it, when the IdP issues one. Write-only. */
export const OrganizationClientSecretSchema = z.string().min(1).max(1024);

/** SAML IdP metadata document location. Fetched server-side under the SSRF guard. */
export const SamlMetadataUrlSchema = OrganizationIssuerUrlSchema;
/** Inline SAML IdP metadata, for operators who paste the document directly. */
export const SamlMetadataXmlSchema = z.string().min(32).max(262_144);

export const UpdateOrganizationRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    ssoIssuer: OrganizationIssuerUrlSchema.nullable().optional(),
    ssoClientId: OrganizationClientIdSchema.nullable().optional(),
    ssoClientSecret: OrganizationClientSecretSchema.nullable().optional(),
    samlIssuer: OrganizationIssuerUrlSchema.nullable().optional(),
    samlMetadataUrl: SamlMetadataUrlSchema.nullable().optional(),
    samlMetadataXml: SamlMetadataXmlSchema.nullable().optional(),
    provisioningEnabled: z.boolean().optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.ssoIssuer !== undefined ||
      value.ssoClientId !== undefined ||
      value.ssoClientSecret !== undefined ||
      value.samlIssuer !== undefined ||
      value.samlMetadataUrl !== undefined ||
      value.samlMetadataXml !== undefined ||
      value.provisioningEnabled !== undefined,
    { message: "at least one field is required" },
  )
  .refine((value) => !(value.samlMetadataUrl && value.samlMetadataXml), {
    message: "samlMetadataUrl and samlMetadataXml are mutually exclusive",
    path: ["samlMetadataXml"],
  });
export type UpdateOrganizationRequest = z.infer<
  typeof UpdateOrganizationRequestSchema
>;

export const OrganizationResponseSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  state: OrganizationStateSchema,
  role: OrganizationRoleSchema,
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ssoIssuer: z.string().optional(),
  ssoClientId: z.string().optional(),
  /**
   * Whether a client secret is configured — never the secret itself. It has to
   * reach the tenant's token endpoint as issued, so there is no digest to show
   * and nothing here an API caller could do with the value (ADR 0005).
   */
  ssoClientSecretConfigured: z.boolean().optional(),
  samlIssuer: z.string().optional(),
  samlMetadataUrl: z.string().optional(),
  /**
   * Whether inline SAML metadata is configured — never the document itself.
   * The XML is multi-KB and of no use to an API caller.
   */
  samlMetadataConfigured: z.boolean().optional(),
  provisioningEnabled: z.boolean().optional(),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

export const OrganizationAuthMethodSchema = z.object({
  kind: OrganizationAuthMethodKindSchema,
  label: z.string(),
  /**
   * The OIDC issuer the browser leg redirects to. Absent for methods that
   * have none: native SAML runs entirely server-side, and LDAP is a
   * first-party credential form on the hosted login page.
   */
  issuer: OrganizationIssuerUrlSchema.optional(),
  /**
   * Native SAML (ADR 0056): the tenant configured IdP metadata, so this
   * method routes through the hosted login page rather than a brokered OIDC
   * round-trip. Absent means the legacy `samlIssuer` meaning — the OIDC
   * issuer of a SAML-brokering Keycloak (ADR 0016).
   */
  native: z.boolean().optional(),
});
export type OrganizationAuthMethod = z.infer<
  typeof OrganizationAuthMethodSchema
>;

export const OrganizationTenantResponseSchema = z.object({
  slug: z.string(),
  displayName: z.string(),
  state: OrganizationStateSchema,
  authMethods: z.array(OrganizationAuthMethodSchema),
});
export type OrganizationTenantResponse = z.infer<
  typeof OrganizationTenantResponseSchema
>;

export const JoinOrganizationTenantRequestSchema = z.object({
  method: OrganizationAuthMethodKindSchema,
  idToken: z.string().min(1).max(16_384),
});
export type JoinOrganizationTenantRequest = z.infer<
  typeof JoinOrganizationTenantRequestSchema
>;

export const OrganizationMembershipResponseSchema = z.object({
  organizationId: z.string(),
  principalId: z.string(),
  role: OrganizationRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrganizationMembershipResponse = z.infer<
  typeof OrganizationMembershipResponseSchema
>;

export const AddOrganizationMemberRequestSchema = z.object({
  principalId: z.string().min(1),
  role: OrganizationRoleSchema,
});
export type AddOrganizationMemberRequest = z.infer<
  typeof AddOrganizationMemberRequestSchema
>;

export const ChangeOrganizationMemberRoleRequestSchema = z.object({
  role: OrganizationRoleSchema,
});
export type ChangeOrganizationMemberRoleRequest = z.infer<
  typeof ChangeOrganizationMemberRoleRequestSchema
>;
