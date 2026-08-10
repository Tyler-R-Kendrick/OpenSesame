import { z } from "zod";

export const OrganizationStateSchema = z.enum([
  "provisional",
  "active",
  "suspended",
  "deleted",
]);

export const OrganizationRoleSchema = z.enum(["owner", "admin", "member"]);
export type OrganizationRole = z.infer<typeof OrganizationRoleSchema>;

export const CreateOrganizationRequestSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1).max(128),
});
export type CreateOrganizationRequest = z.infer<
  typeof CreateOrganizationRequestSchema
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
});
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;

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
