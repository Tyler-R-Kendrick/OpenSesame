import { z } from "zod";

/**
 * Wire contracts for webhook endpoint registration (ADR 0046 decision 12).
 *
 * An endpoint receives Standard Webhooks-signed notifications for the
 * registering principal's own authorization-request events. The signing
 * secret appears exactly once, in the registration response; every later
 * surface masks it.
 */

export const RegisterWebhookEndpointSchema = z.object({
  /**
   * https only, because the payload names authorization requests and the
   * signature secret proves nothing to a network eavesdropper.
   */
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => value.startsWith("https://"), {
      message: "webhook endpoints must be https",
    }),
  description: z.string().max(200).optional(),
});

export const WebhookEndpointResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** Masked everywhere except the registration response. */
  secret: z.string(),
  description: z.string().optional(),
  createdAt: z.string().datetime(),
});

/** The event payload a receiver gets. Digest-shaped keys only — no secrets. */
export const WebhookEventSchema = z.object({
  eventType: z.enum([
    "authority.invocation.requested",
    "authority.invocation.completed",
  ]),
  authReqId: z.string(),
  requestDigest: z.string(),
  status: z.string().optional(),
  decidedByKind: z.string().optional(),
  expiresAt: z.string().optional(),
});
