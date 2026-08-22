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

export const ExternalIdentityKindSchema = z.enum([
  "oidc",
  "oauth_profile",
  "passkey",
  "atproto",
  "nostr",
  "spiffe",
  "auth_md",
  "enterprise_directory",
]);

export const IdentitySummarySchema = z.object({
  id: z.string(),
  kind: z.string(),
  issuer: z.string(),
  subject: z.string().optional(),
  displayHint: z.string().optional(),
  assurance: AssuranceLevelSchema,
  linkedAt: z.string().datetime().optional(),
});
export type IdentitySummary = z.infer<typeof IdentitySummarySchema>;

export const LinkIdentityRequestSchema = z.union([
  z.object({
    /** Verified upstream assertion. Production claim path (ADR 0033). */
    idToken: z.string().min(16),
  }),
  z.object({
    kind: ExternalIdentityKindSchema,
    issuer: z.string().min(1),
    subject: z.string().min(1),
    tenant: z.string().optional(),
    displayHint: z.string().optional(),
    /** Email is never used for auto-link; accepted only as a display hint. */
    emailNormalized: z.string().email().optional(),
    emailVerified: z.boolean().optional(),
    assurance: AssuranceLevelSchema.default("verified"),
  }),
]);
export type LinkIdentityRequest = z.infer<typeof LinkIdentityRequestSchema>;

export const LinkIdentityResponseSchema = z.object({
  identity: IdentitySummarySchema,
  principalId: z.string(),
});
export type LinkIdentityResponse = z.infer<typeof LinkIdentityResponseSchema>;

export const IdentityListResponseSchema = z.object({
  identities: z.array(IdentitySummarySchema),
});
export type IdentityListResponse = z.infer<typeof IdentityListResponseSchema>;
