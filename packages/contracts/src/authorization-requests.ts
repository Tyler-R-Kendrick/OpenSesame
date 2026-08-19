import { z } from "zod";

/**
 * Wire contracts for the authorization-request inbox (ADR 0046).
 *
 * The shapes are CIBA-shaped on purpose: an opaque `authReqId`, a TTL, a poll
 * interval, and a binding message the requester and the approver both see.
 */

export const AuthorizationRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);

export const ApprovalDecidedByKindSchema = z.enum(["human", "agent"]);

/**
 * One RFC 9396 `authorization_details` entry.
 *
 * `type` is required because it selects how the rest is read; the remaining
 * fields are the common ones the RFC names, and unknown keys are kept so a
 * connector-specific detail survives round-tripping into the consent echo.
 */
export const AuthorizationDetailSchema = z
  .object({
    type: z.string().min(1).max(128),
    locations: z.array(z.string().max(512)).max(32).optional(),
    actions: z.array(z.string().max(128)).max(32).optional(),
    datatypes: z.array(z.string().max(128)).max(32).optional(),
    identifier: z.string().max(256).optional(),
    privileges: z.array(z.string().max(128)).max(32).optional(),
  })
  .passthrough();

export const CreateAuthorizationRequestSchema = z.object({
  /**
   * The approver's inbox handle, obtained from
   * `GET /v1/authorization-requests/inbox-ref` by its owner and shared
   * deliberately.
   *
   * Not a principal id: knowing who someone is must not be enough to put text
   * in front of them, and an address that could be guessed would turn this
   * route into an oracle for which principal ids exist. The handle is
   * server-minted and MAC-bound, so holding one is what authorizes the asking.
   */
  approverRef: z.string().min(8).max(256),
  authorizationDetails: z.array(AuthorizationDetailSchema).min(1).max(32),
  /**
   * Shown identically to the requester and the approver, so a person can tell
   * "the thing I just started" from "something else asking right now".
   */
  bindingMessage: z.string().min(4).max(120),
  connectionId: z.string().min(1).optional(),
  delegationId: z.string().min(1).optional(),
  /** Seconds. Bounded: an inbox item that outlives its context is a trap. */
  ttlSeconds: z.number().int().min(30).max(3600).optional(),
});

export const AuthorizationRequestResponseSchema = z.object({
  authReqId: z.string(),
  status: AuthorizationRequestStatusSchema,
  bindingMessage: z.string(),
  /**
   * The digest of exactly what was asked. An executor compares its own
   * canonical digest to this before running anything, so approving one request
   * cannot authorize a different one.
   */
  requestDigest: z.string(),
  authorizationDetails: z.array(AuthorizationDetailSchema),
  expiresAt: z.string().datetime(),
  intervalSeconds: z.number().int(),
  connectionId: z.string().optional(),
  delegationId: z.string().optional(),
  decidedAt: z.string().datetime().optional(),
  decidedByKind: ApprovalDecidedByKindSchema.optional(),
});

export const DecideAuthorizationRequestSchema = z.object({
  /**
   * Echoed back by the approver. It is checked against the stored digest, so a
   * request that changed between being shown and being approved is refused
   * rather than silently consented to.
   */
  requestDigest: z.string().min(16),
});

export type AuthorizationDetail = z.infer<typeof AuthorizationDetailSchema>;
export type CreateAuthorizationRequest = z.infer<
  typeof CreateAuthorizationRequestSchema
>;
export type AuthorizationRequestResponse = z.infer<
  typeof AuthorizationRequestResponseSchema
>;
