import { z } from "zod";

export const AssuranceLevelSchema = z.enum([
  "provisional",
  "self_asserted",
  "verified",
  "mfa",
  "phishing_resistant",
  "enterprise_managed",
  "workload_attested",
]);

export const PrincipalStateSchema = z.enum([
  "provisional",
  "active",
  "suspended",
  "closed",
]);

export const PrincipalMeResponseSchema = z.object({
  id: z.string(),
  state: PrincipalStateSchema,
  assurance: AssuranceLevelSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  verifiedAt: z.string().datetime().optional(),
  version: z.number().int().positive(),
  identities: z
    .array(
      z.object({
        id: z.string(),
        kind: z.string(),
        issuer: z.string(),
        displayHint: z.string().optional(),
        assurance: AssuranceLevelSchema,
      }),
    )
    .default([]),
});
export type PrincipalMeResponse = z.infer<typeof PrincipalMeResponseSchema>;
