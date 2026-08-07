import { z } from "zod";

export const ProjectStateSchema = z.enum([
  "provisional",
  "active",
  "expired",
  "deleting",
  "deleted",
]);

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
