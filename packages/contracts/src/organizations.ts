import { z } from "zod";

export const OrganizationStateSchema = z.enum([
  "provisional",
  "active",
  "suspended",
  "deleted",
]);

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const OrganizationAuthMethodKindSchema = z.enum(["sso", "saml"]);
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

export const UpdateOrganizationRequestSchema = z
  .object({
    displayName: z.string().min(1).max(128).optional(),
    ssoIssuer: OrganizationIssuerUrlSchema.nullable().optional(),
    samlIssuer: OrganizationIssuerUrlSchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.displayName !== undefined ||
      value.ssoIssuer !== undefined ||
      value.samlIssuer !== undefined,
    { message: "at least one field is required" },
  );
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
  samlIssuer: z.string().optional(),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

export const OrganizationAuthMethodSchema = z.object({
  kind: OrganizationAuthMethodKindSchema,
  label: z.string(),
  issuer: OrganizationIssuerUrlSchema,
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
