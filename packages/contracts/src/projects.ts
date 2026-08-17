import { z } from "zod";

export const ProjectStateSchema = z.enum([
  "provisional",
  "active",
  "expired",
  "deleting",
  "deleted",
]);

export const ProjectKindSchema = z.enum(["personal", "standard", "temporary"]);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

export const ProjectRoleSchema = z.enum(["owner", "admin", "member"]);
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

export const CreateProjectRequestSchema = z.object({
  displayName: z.string().min(1).max(128),
  slug: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  organizationId: z.string().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectResponseSchema = z.object({
  id: z.string(),
  kind: ProjectKindSchema,
  slug: z.string(),
  displayName: z.string(),
  state: ProjectStateSchema,
  role: ProjectRoleSchema,
  ownerPrincipalId: z.string().optional(),
  organizationId: z.string().optional(),
  expiresAt: z.string().datetime().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

export const ProjectMembershipResponseSchema = z.object({
  projectId: z.string(),
  principalId: z.string(),
  role: ProjectRoleSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectMembershipResponse = z.infer<
  typeof ProjectMembershipResponseSchema
>;

export const AddProjectMemberRequestSchema = z.object({
  principalId: z.string().min(1),
  role: ProjectRoleSchema,
});
export type AddProjectMemberRequest = z.infer<
  typeof AddProjectMemberRequestSchema
>;

export const ChangeProjectMemberRoleRequestSchema = z.object({
  role: ProjectRoleSchema,
});
export type ChangeProjectMemberRoleRequest = z.infer<
  typeof ChangeProjectMemberRoleRequestSchema
>;

export const ActiveProjectResponseSchema = z.object({
  project: ProjectResponseSchema,
  /** True when the active project fell back to the personal default. */
  isFallback: z.boolean(),
});
export type ActiveProjectResponse = z.infer<typeof ActiveProjectResponseSchema>;

export const SetActiveProjectRequestSchema = z.object({
  projectId: z.string().min(1),
});
export type SetActiveProjectRequest = z.infer<
  typeof SetActiveProjectRequestSchema
>;

export const CreateTemporaryProjectRequestSchema = z.object({
  name: z.string().min(1).max(128),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  ttlSeconds: z.number().int().positive().max(604_800).optional(),
});
export type CreateTemporaryProjectRequest = z.infer<
  typeof CreateTemporaryProjectRequestSchema
>;

export const CreateTemporaryProjectResponseSchema = z.object({
  projectId: z.string(),
  state: z.literal("provisional"),
  displayName: z.string(),
  expiresAt: z.string().datetime(),
  claimId: z.string(),
  claimToken: z.string().regex(/^osc_clm_/),
  userCode: z.string(),
  verificationUri: z.string().url(),
  targetManifestDigest: z.string(),
});
export type CreateTemporaryProjectResponse = z.infer<
  typeof CreateTemporaryProjectResponseSchema
>;
