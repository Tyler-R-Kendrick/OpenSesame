import { z } from "zod";

export const ClaimTargetTypeSchema = z.enum([
  "principal",
  "agent",
  "project",
  "resource_bundle",
  "device",
  "connection",
]);

export const ClaimStateSchema = z.enum([
  "pending",
  "presented",
  "authenticated",
  "reviewed",
  "completed",
  "denied",
  "revoked",
  "expired",
]);

export const CreateClaimRequestSchema = z.object({
  type: ClaimTargetTypeSchema,
  targetManifest: z.record(z.unknown()),
  ttlSeconds: z.number().int().positive().max(86_400).optional(),
  proofKeyJkt: z.string().min(8).optional(),
  requestedDestination: z.record(z.unknown()).optional(),
  requestedGrant: z.record(z.unknown()).optional(),
});
export type CreateClaimRequest = z.infer<typeof CreateClaimRequestSchema>;

export const CreateClaimResponseSchema = z.object({
  claimId: z.string(),
  claimToken: z.string().regex(/^osc_clm_/),
  userCode: z.string().min(4),
  verificationUri: z.string().url(),
  expiresAt: z.string().datetime(),
  targetManifestDigest: z.string(),
  pollIntervalSeconds: z.number().int().positive(),
});
export type CreateClaimResponse = z.infer<typeof CreateClaimResponseSchema>;

export const PresentClaimRequestSchema = z.object({
  token: z.string().min(16),
  /**
   * Optional second factor (ADR 0062). When supplied it is verified against
   * the claim's peppered digest *before* the single-use presentation is
   * spent, so a wrong code cannot burn the claim. Omitting it keeps the
   * original token-only presentation.
   */
  userCode: z.string().min(4).max(64).optional(),
});
export type PresentClaimRequest = z.infer<typeof PresentClaimRequestSchema>;

export const ReviewClaimRequestSchema = z.object({
  acceptedItemIds: z.array(z.string()),
  destination: z.record(z.unknown()).optional(),
});
export type ReviewClaimRequest = z.infer<typeof ReviewClaimRequestSchema>;

export const CompleteClaimRequestSchema = z.object({
  acceptedItemIds: z.array(z.string()),
  /**
   * Code shown by the device being claimed. Approval is a human consent step,
   * so the approver must prove they are looking at that device.
   */
  userCode: z.string().min(4).max(64),
  /**
   * Optional claim bearer. When present it must match this claim; Identity
   * already requires an authenticated principal plus the user code.
   */
  claimToken: z
    .string()
    .regex(/^osc_clm_/)
    .optional(),
  destination: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().min(8).optional(),
});
export type CompleteClaimRequest = z.infer<typeof CompleteClaimRequestSchema>;

/**
 * Item projection returned with a claim so a reviewer can accept by id.
 * There is no wildcard — `acceptedItemIds` must name every accepted item.
 */
export const ClaimItemResponseSchema = z.object({
  id: z.string(),
  targetType: z.enum(["project", "resource", "agent", "device", "connection"]),
  targetId: z.string(),
  requestedAction: z.enum(["attach", "transfer", "delegate", "verify"]),
  required: z.boolean(),
  dependencies: z.array(z.string()),
  state: z.enum(["pending", "accepted", "rejected"]),
});
export type ClaimItemResponse = z.infer<typeof ClaimItemResponseSchema>;

export const ClaimSessionResponseSchema = z.object({
  id: z.string(),
  type: ClaimTargetTypeSchema,
  state: ClaimStateSchema,
  targetManifestDigest: z.string(),
  expiresAt: z.string().datetime(),
  version: z.number().int().positive(),
  completedByPrincipalId: z.string().optional(),
  /**
   * Always projected, empty when the claim covers nothing enumerable.
   *
   * It is required rather than optional so that "no items" cannot be confused
   * with "this server did not say": a consumer that read an absent field as
   * the empty set would silently accept an item-bearing claim without ever
   * showing what it covers.
   */
  items: z.array(ClaimItemResponseSchema),
});
export type ClaimSessionResponse = z.infer<typeof ClaimSessionResponseSchema>;

/**
 * Presentation is the single-use transition, so the present response — and
 * only the present response — carries the stored manifest (ADR 0062): the
 * ciphertext a drop recipient decrypts is served exactly once, inside the one
 * presentation window. GET/poll/complete keep projecting only the digest.
 */
export const PresentClaimResponseSchema = ClaimSessionResponseSchema.extend({
  targetManifest: z.record(z.unknown()),
});
export type PresentClaimResponse = z.infer<typeof PresentClaimResponseSchema>;
