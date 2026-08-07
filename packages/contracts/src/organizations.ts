import { z } from "zod";

export const OrganizationStateSchema = z.enum([
  "provisional",
  "active",
  "suspended",
  "deleted",
]);

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
  createdBy: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponseSchema>;
